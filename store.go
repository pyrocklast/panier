package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// The server never sees list contents. Each list is a directory holding:
//
//	auth  SHA-256 of the list's access token, in hex
//	log   one encrypted change per line, in arrival order; the line number is its sequence number
//
// Lists are loaded on first use and kept in memory; a shopping list's log stays small.

var (
	errExists   = errors.New("list already exists")
	errNotFound = errors.New("list not found")
	idPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

type store struct {
	dir   string
	mu    sync.Mutex
	lists map[string]*list
}

type list struct {
	mu      sync.Mutex
	auth    [sha256.Size]byte
	changes []string
	log     *os.File
	subs    map[chan int]struct{}
}

type change struct {
	Seq  int    `json:"seq"`
	Data string `json:"data"`
}

func openStore(dir string) (*store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "lists"), 0o700); err != nil {
		return nil, err
	}
	return &store{dir: dir, lists: map[string]*list{}}, nil
}

func (s *store) listDir(id string) string { return filepath.Join(s.dir, "lists", id) }

func (s *store) create(id string, token []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := s.listDir(id)
	if _, err := os.Stat(dir); err == nil {
		return errExists
	}
	tmp := dir + ".new"
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return err
	}
	sum := sha256.Sum256(token)
	if err := os.WriteFile(filepath.Join(tmp, "auth"), []byte(hex.EncodeToString(sum[:])+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tmp, "log"), nil, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, dir)
}

func (s *store) get(id string) (*list, error) {
	if !idPattern.MatchString(id) {
		return nil, errNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := s.lists[id]; ok {
		return l, nil
	}
	dir := s.listDir(id)
	authHex, err := os.ReadFile(filepath.Join(dir, "auth"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNotFound
	} else if err != nil {
		return nil, err
	}
	l := &list{subs: map[chan int]struct{}{}}
	if n, err := hex.Decode(l.auth[:], bytes.TrimSpace(authHex)); err != nil || n != sha256.Size {
		return nil, errors.New("corrupt auth file for list " + id)
	}
	path := filepath.Join(dir, "log")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// A crash mid-write can leave a partial last line; drop it.
	if i := bytes.LastIndexByte(data, '\n'); i+1 < len(data) {
		data = data[:i+1]
		if err := os.Truncate(path, int64(len(data))); err != nil {
			return nil, err
		}
	}
	if len(data) > 0 {
		l.changes = strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	}
	if l.log, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600); err != nil {
		return nil, err
	}
	s.lists[id] = l
	return l, nil
}

func (s *store) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.lists {
		l.log.Close()
	}
}

func (l *list) allows(token []byte) bool {
	sum := sha256.Sum256(token)
	return subtle.ConstantTimeCompare(sum[:], l.auth[:]) == 1
}

// add appends encrypted changes and returns the latest sequence number.
func (l *list) add(data []string) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, d := range data {
		b.WriteString(d)
		b.WriteByte('\n')
	}
	if _, err := l.log.WriteString(b.String()); err != nil {
		return 0, err
	}
	if err := l.log.Sync(); err != nil {
		return 0, err
	}
	l.changes = append(l.changes, data...)
	latest := len(l.changes)
	for ch := range l.subs {
		select {
		case ch <- latest:
		default: // the listener already has a newer number waiting
		}
	}
	return latest, nil
}

// since returns up to max changes after sequence number n, and the latest sequence number.
func (l *list) since(n, max int) ([]change, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	latest := len(l.changes)
	if n < 0 {
		n = 0
	}
	out := []change{}
	for i := n; i < latest && len(out) < max; i++ {
		out = append(out, change{Seq: i + 1, Data: l.changes[i]})
	}
	return out, latest
}

func (l *list) latest() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.changes)
}

// subscribe returns a channel that receives the latest sequence number after each append.
func (l *list) subscribe(limit int) (chan int, func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.subs) >= limit {
		return nil, nil, false
	}
	ch := make(chan int, 1)
	l.subs[ch] = struct{}{}
	return ch, func() {
		l.mu.Lock()
		delete(l.subs, ch)
		l.mu.Unlock()
	}, true
}
