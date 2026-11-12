package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxBody       = 256 << 10 // per request
	maxChange     = 16 << 10  // per encrypted change
	maxPerRequest = 200
	maxPerPage    = 1000
	maxListeners  = 16 // live connections per list
)

var changePattern = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// setupFailDelay slows down wrong setup codes. The code is too long to guess anyway;
// this keeps automated guessing from even trying quickly.
var setupFailDelay = time.Second

type server struct {
	store     *store
	setupCode string
	web       fs.FS
}

func (sv *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/lists", sv.createList)
	mux.HandleFunc("DELETE /api/lists/{id}", sv.withList(sv.closeList, false))
	mux.HandleFunc("GET /api/lists/{id}/changes", sv.withList(sv.getChanges, false))
	mux.HandleFunc("POST /api/lists/{id}/changes", sv.withList(sv.postChanges, false))
	mux.HandleFunc("GET /api/lists/{id}/live", sv.withList(sv.live, true))
	mux.Handle("/api/", http.NotFoundHandler())
	mux.Handle("/", staticFiles(sv.web))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "+
			"font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}

func fail(w http.ResponseWriter, code int, msg string) {
	http.Error(w, msg, code)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func decodeToken(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return b, err == nil && len(b) == 32
}

// createList registers a new list: with the server's setup code, so only the person
// who installed the server can start the first one, or vouched for by a list already
// here, named in "by", with its token in the Authorization header. A list made that
// way joins the family of the list that vouched, which holds maxFamily lists at most.
// The id and token come from the list key, which never leaves the phones.
func (sv *server) createList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string  `json:"id"`
		Auth string  `json:"auth"`
		By   *string `json:"by"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "bad request")
		return
	}
	token, ok := decodeToken(req.Auth)
	if !idPattern.MatchString(req.ID) || !ok {
		fail(w, http.StatusBadRequest, "bad id or token")
		return
	}
	root := req.ID
	if req.By != nil {
		voucher, ok := decodeToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if !idPattern.MatchString(*req.By) || *req.By == req.ID || !ok {
			fail(w, http.StatusBadRequest, "bad voucher")
			return
		}
		if root, ok = sv.store.vouch(*req.By, voucher); !ok {
			time.Sleep(setupFailDelay)
			fail(w, http.StatusForbidden, "that list can't vouch for a new one")
			return
		}
		switch room, err := sv.store.spend(root); {
		case err != nil:
			log.Printf("vouch: %v", err)
			fail(w, http.StatusInternalServerError, "could not create list")
			return
		case !room:
			fail(w, http.StatusForbidden, "no more lists can be made from that list")
			return
		}
	} else if subtle.ConstantTimeCompare([]byte(normalizeCode(r.Header.Get("X-Setup-Code"))), []byte(sv.setupCode)) != 1 {
		time.Sleep(setupFailDelay)
		fail(w, http.StatusForbidden, "wrong setup code")
		return
	}
	switch err := sv.store.create(req.ID, token, root); {
	case errors.Is(err, errExists):
		fail(w, http.StatusConflict, "list already exists")
	case err != nil:
		log.Printf("create list: %v", err)
		fail(w, http.StatusInternalServerError, "could not create list")
	default:
		w.WriteHeader(http.StatusCreated)
	}
}

// withList checks the access token: in the Authorization header, or for live updates,
// as a WebSocket subprotocol.
func (sv *server) withList(h func(http.ResponseWriter, *http.Request, *list), live bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if live {
			raw = protocolToken(r)
		}
		token, ok := decodeToken(raw)
		if !ok {
			fail(w, http.StatusUnauthorized, "missing token")
			return
		}
		l, err := sv.store.get(r.PathValue("id"))
		if errors.Is(err, errNotFound) {
			fail(w, http.StatusNotFound, "no such list")
			return
		} else if err != nil {
			log.Printf("open list: %v", err)
			fail(w, http.StatusInternalServerError, "could not open list")
			return
		}
		if !l.allows(token) {
			fail(w, http.StatusUnauthorized, "wrong token")
			return
		}
		if r.Method != http.MethodDelete && l.closed() {
			fail(w, http.StatusGone, "this list was closed")
			return
		}
		h(w, r, l)
	}
}

// closeList deletes a list's changes for good; it then refuses everything. Anyone who
// holds the list can close it, as anyone who holds it can empty it.
func (sv *server) closeList(w http.ResponseWriter, r *http.Request, l *list) {
	if err := l.close(); err != nil {
		log.Printf("close list: %v", err)
		fail(w, http.StatusInternalServerError, "could not close the list")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (sv *server) getChanges(w http.ResponseWriter, r *http.Request, l *list) {
	since := 0
	if s := r.URL.Query().Get("since"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			fail(w, http.StatusBadRequest, "since must be a sequence number")
			return
		}
		since = n
	}
	changes, latest := l.since(since, maxPerPage)
	writeJSON(w, http.StatusOK, map[string]any{"changes": changes, "latest": latest})
}

func (sv *server) postChanges(w http.ResponseWriter, r *http.Request, l *list) {
	var req struct {
		Changes []string `json:"changes"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "bad request")
		return
	}
	if len(req.Changes) == 0 || len(req.Changes) > maxPerRequest {
		fail(w, http.StatusBadRequest, "send between 1 and 200 changes")
		return
	}
	for _, c := range req.Changes {
		if len(c) > maxChange || !changePattern.MatchString(c) {
			fail(w, http.StatusBadRequest, "changes must be base64")
			return
		}
	}
	latest, err := l.add(req.Changes)
	switch {
	case errors.Is(err, errFull):
		fail(w, http.StatusInsufficientStorage, "this list is full")
		return
	case errors.Is(err, errClosed):
		fail(w, http.StatusGone, "this list was closed")
		return
	case errors.Is(err, errBroken):
		fail(w, http.StatusServiceUnavailable, "the server needs a restart")
		return
	case err != nil:
		log.Printf("append: %v", err)
		fail(w, http.StatusInternalServerError, "could not save")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"latest": latest})
}
