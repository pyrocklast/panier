package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// staticFiles serves the app's files, gzipped for browsers that accept it. The text files
// are compressed once, when the server starts; fonts and images are compressed already.
// Each file has an ETag, from its contents, so a browser that has it already, such as the
// service worker checking sw.js each time the app opens, gets 304 Not Modified rather than
// the file again. A gzipped copy has its own, as its bytes differ.
func staticFiles(files fs.FS) http.Handler {
	plain := http.FileServerFS(files)
	gz, tags := map[string][]byte{}, map[string]string{}
	fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(files, p)
		if err != nil {
			return nil
		}
		sum := sha256.Sum256(data)
		tags["/"+p] = hex.EncodeToString(sum[:12])
		switch path.Ext(p) {
		case ".html", ".js", ".css", ".svg", ".webmanifest", ".txt":
		default:
			return nil
		}
		var b bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
		zw.Write(data)
		zw.Close()
		gz["/"+p] = b.Bytes()
		return nil
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept-Encoding")
		p := path.Clean(r.URL.Path)
		if p == "/" {
			p = "/index.html"
		}
		tag, known := tags[p]
		if r.URL.Path == "/index.html" {
			known = false // sent on to /
		}
		z, ok := gz[p]
		if !ok || !known || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			if known {
				w.Header().Set("ETag", `"`+tag+`"`)
			}
			plain.ServeHTTP(w, r) // which also sends /index.html on to /
			return
		}
		w.Header().Set("ETag", `"`+tag+`-gz"`)
		w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(p)))
		w.Header().Set("Content-Encoding", "gzip")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(z))
	})
}
