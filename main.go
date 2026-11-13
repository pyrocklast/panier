// Panier is a private, shared shopping list. This program serves the app and relays
// end-to-end encrypted changes between phones; it cannot read the lists it stores.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var webFiles embed.FS

var version = "dev"

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "address to listen on")
	data := flag.String("data", "data", "directory for lists and the setup code")
	showCode := flag.Bool("setup-code", false, "print the setup code and exit")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	st, err := openStore(*data)
	if err != nil {
		log.Fatal(err)
	}
	code, err := setupCode(*data)
	if err != nil {
		log.Fatal(err)
	}
	if *showCode {
		fmt.Println(code)
		return
	}
	web, _ := fs.Sub(webFiles, "web")
	sv := &server{store: st, setupCode: code, web: web}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           sv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No write timeout: live updates keep a response open.
	}

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if srv.Shutdown(ctx) != nil {
			srv.Close() // live-update connections never finish on their own
		}
	}()

	log.Printf("Panier %s listening on %s, data in %s", version, *addr, *data)
	log.Printf("To create a list, open https://<your address>/#setup=%s on the first phone", code)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	st.close()
}

// setupCode returns the code that allows creating lists, generating it on first run.
func setupCode(dir string) (string, error) {
	path := filepath.Join(dir, "setup-code")
	if b, err := os.ReadFile(path); err == nil {
		return normalizeCode(string(b)), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no look-alike characters
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	code := string(b[:4]) + "-" + string(b[4:8]) + "-" + string(b[8:])
	return code, os.WriteFile(path, []byte(code+"\n"), 0o600)
}

func normalizeCode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

func init() {
	// Not every system's MIME table knows these.
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".woff2", "font/woff2")
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
}
