package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
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
//	info  the list's family and, once closed, that it is: see listInfo
//
// Lists are loaded on first use and kept in memory; a shopping list's log stays small,
// and maxLogBytes caps it in case a paired phone misbehaves.

var (
	errExists   = errors.New("list already exists")
	errNotFound = errors.New("list not found")
	errFull     = errors.New("list is full")
	errClosed   = errors.New("list was closed")
	errBroken   = errors.New("list log needs a restart to recover")
	idPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)

	maxLogBytes int64 = 32 << 20 // several years of use for two people
	maxFamily         = 100      // lists made from one list created with the setup code, itself not counted
)

// listInfo is a list's place in its family: Root is the list created with the setup code
// that it descends from, or its own id, and Made, on that list, counts the lists made
// from it. A closed list keeps its info, and refuses everything else.
type listInfo struct {
	Root   string `json:"root"`
	Made   int    `json:"made,omitempty"`
	Closed bool   `json:"closed,omitempty"`
}

type store struct {
	dir   string
	mu    sync.Mutex
	lists map[string]*list
}

// logFile is the part of *os.File the store uses; tests replace it to simulate disk errors.
type logFile interface {
	WriteString(string) (int, error)
	Sync() error
	Truncate(int64) error
	Close() error
}

type list struct {
	mu      sync.Mutex
	dir     string
	info    listInfo
	auth    [sha256.Size]byte
	changes []string
	log     logFile
	size    int64 // bytes of complete lines in the log
	broken  bool  // a failed write couldn't be undone; refuse writes until restart
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

// create registers a list in root's family: root is its own id for a list created with
// the setup code.
func (s *store) create(id string, token []byte, root string) error {
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
	if err := writeInfo(tmp, listInfo{Root: root}); err != nil {
		return err
	}
	return os.Rename(tmp, dir)
}

// writeInfo replaces a list's info file in one step, so a crash leaves the old one or the new.
func writeInfo(dir string, info listInfo) error {
	b, _ := json.Marshal(info)
	if err := os.WriteFile(filepath.Join(dir, "info.new"), append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(filepath.Join(dir, "info.new"), filepath.Join(dir, "info"))
}

// vouch returns the family of list id, if token is its token and it isn't closed.
func (s *store) vouch(id string, token []byte) (string, bool) {
	l, err := s.get(id)
	if err != nil || !l.allows(token) {
		return "", false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.info.Root, !l.info.Closed
}

// spend counts one more list made in root's family, if there's room.
func (s *store) spend(root string) (bool, error) {
	l, err := s.get(root)
	if err != nil {
		return false, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.info.Made >= maxFamily {
		return false, nil
	}
	info := l.info
	info.Made++
	if err := writeInfo(l.dir, info); err != nil {
		return false, err
	}
	l.info = info
	return true, nil
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
	l := &list{dir: dir, info: listInfo{Root: id}, subs: map[chan int]struct{}{}}
	if n, err := hex.Decode(l.auth[:], bytes.TrimSpace(authHex)); err != nil || n != sha256.Size {
		return nil, errors.New("corrupt auth file for list " + id)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "info")); err == nil {
		if json.Unmarshal(b, &l.info) != nil || !idPattern.MatchString(l.info.Root) {
			return nil, errors.New("corrupt info file for list " + id)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
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
	l.size = int64(len(data))
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

func (l *list) closed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.info.Closed
}

// close deletes the list's changes and marks it closed; phones listening are told.
func (l *list) close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.info.Closed {
		return nil
	}
	info := l.info
	info.Closed = true
	if err := writeInfo(l.dir, info); err != nil {
		return err
	}
	l.info = info
	if err := l.log.Truncate(0); err != nil {
		l.broken = true
		log.Printf("could not empty a closed list's log: %v", err)
	}
	l.changes, l.size = nil, 0
	for ch := range l.subs { // closing replaces any number waiting: it is the last news
		select {
		case <-ch:
		default:
		}
		ch <- -1 // never blocks: only this list, under its lock, sends
	}
	return nil
}

// add appends encrypted changes and returns the latest sequence number. Either all
// of them are saved or none: a failed write is cut back off the end of the log, so
// sequence numbers on disk always match the ones already handed to phones.
func (l *list) add(data []string) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.info.Closed {
		return 0, errClosed
	}
	if l.broken {
		return 0, errBroken
	}
	var b strings.Builder
	for _, d := range data {
		b.WriteString(d)
		b.WriteByte('\n')
	}
	if l.size+int64(b.Len()) > maxLogBytes {
		return 0, errFull
	}
	n, err := l.log.WriteString(b.String())
	if err == nil {
		err = l.log.Sync()
	}
	if err != nil {
		if terr := l.log.Truncate(l.size); terr != nil {
			l.broken = true
			log.Printf("could not undo a failed write (%v); refusing writes to this list until restart", terr)
		}
		return 0, err
	}
	l.size += int64(n)
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
	out := []change{}
	for i := max0(n); i < latest && len(out) < max; i++ {
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

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}
