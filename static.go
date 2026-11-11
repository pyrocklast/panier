package main

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// staticFiles serves the app's files, gzipped for browsers that accept it. The text files
// are compressed once, when the server starts; fonts and images are compressed already.
func staticFiles(files fs.FS) http.Handler {
	plain := http.FileServerFS(files)
	gz := map[string][]byte{}
	fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		switch path.Ext(p) {
		case ".html", ".js", ".css", ".svg", ".webmanifest", ".txt":
		default:
			return nil
		}
		data, err := fs.ReadFile(files, p)
		if err != nil {
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
		z, ok := gz[p]
		if !ok || r.URL.Path == "/index.html" || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			plain.ServeHTTP(w, r) // which also sends /index.html on to /
			return
		}
		w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(p)))
		w.Header().Set("Content-Encoding", "gzip")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(z))
	})
}
