package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

const testCode = "ABCD-EFGH-JKMN"

var (
	testID    = strings.Repeat("ab", 16)
	testToken = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
)

func newTestServer(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	web := fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}}
	ts := httptest.NewServer((&server{store: st, setupCode: testCode, web: web}).routes())
	t.Cleanup(func() { ts.Close(); st.close() })
	return ts
}

func do(t *testing.T, method, url, token, code string, body any) *http.Response {
	t.Helper()
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if code != "" {
		req.Header.Set("X-Setup-Code", code)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func create(t *testing.T, ts *httptest.Server) {
	t.Helper()
	res := do(t, "POST", ts.URL+"/api/lists", "", testCode, map[string]string{"id": testID, "auth": testToken})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", res.StatusCode)
	}
}

func TestCreateNeedsSetupCode(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	body := map[string]string{"id": testID, "auth": testToken}
	if res := do(t, "POST", ts.URL+"/api/lists", "", "WRONG", body); res.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong code: got %d", res.StatusCode)
	}
	if res := do(t, "POST", ts.URL+"/api/lists", "", strings.ToLower(testCode), body); res.StatusCode != http.StatusCreated {
		t.Fatalf("lower-case code: got %d", res.StatusCode)
	}
	if res := do(t, "POST", ts.URL+"/api/lists", "", testCode, body); res.StatusCode != http.StatusConflict {
		t.Fatalf("second create: got %d", res.StatusCode)
	}
	if res := do(t, "POST", ts.URL+"/api/lists", "", testCode, map[string]string{"id": "../x", "auth": testToken}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad id: got %d", res.StatusCode)
	}
}

func TestChangesRoundTripAndAuth(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	create(t, ts)
	url := ts.URL + "/api/lists/" + testID + "/changes"

	other := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	if res := do(t, "GET", url, other, "", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d", res.StatusCode)
	}
	if res := do(t, "GET", url, "", "", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", res.StatusCode)
	}
	if res := do(t, "POST", url, testToken, "", map[string][]string{"changes": {"bad\nline"}}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("newline in change: got %d", res.StatusCode)
	}

	res := do(t, "POST", url, testToken, "", map[string][]string{"changes": {"QUJD", "REVG"}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("post: got %d", res.StatusCode)
	}
	res = do(t, "GET", url+"?since=1", testToken, "", nil)
	var got struct {
		Changes []change
		Latest  int
	}
	json.NewDecoder(res.Body).Decode(&got)
	if got.Latest != 2 || len(got.Changes) != 1 || got.Changes[0].Seq != 2 || got.Changes[0].Data != "REVG" {
		t.Fatalf("since=1: got %+v", got)
	}
}

func TestReloadDropsPartialLine(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	create(t, ts)
	url := ts.URL + "/api/lists/" + testID + "/changes"
	do(t, "POST", url, testToken, "", map[string][]string{"changes": {"QUJD"}})
	ts.Close()

	f, _ := os.OpenFile(filepath.Join(dir, "lists", testID, "log"), os.O_WRONLY|os.O_APPEND, 0)
	f.WriteString("UNFINISH")
	f.Close()

	ts2 := newTestServer(t, dir)
	url2 := ts2.URL + "/api/lists/" + testID + "/changes"
	do(t, "POST", url2, testToken, "", map[string][]string{"changes": {"REVG"}})
	res := do(t, "GET", url2, testToken, "", nil)
	var got struct{ Changes []change }
	json.NewDecoder(res.Body).Decode(&got)
	if len(got.Changes) != 2 || got.Changes[1].Data != "REVG" || got.Changes[1].Seq != 2 {
		t.Fatalf("after reload: got %+v", got.Changes)
	}
}

func TestEventsAnnounceNewChanges(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/lists/"+testID+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	lines := bufio.NewScanner(res.Body)
	next := func() string {
		for lines.Scan() {
			if s := lines.Text(); strings.HasPrefix(s, "data: ") {
				return strings.TrimPrefix(s, "data: ")
			}
		}
		return ""
	}
	if got := next(); got != "0" {
		t.Fatalf("first event: got %q", got)
	}
	do(t, "POST", ts.URL+"/api/lists/"+testID+"/changes", testToken, "", map[string][]string{"changes": {"QUJD"}})
	if got := next(); got != "1" {
		t.Fatalf("after post: got %q", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	res := do(t, "GET", ts.URL+"/", "", "", nil)
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src 'self'") {
		t.Fatal("missing content security policy")
	}
}

func init() { setupFailDelay = 0 }

func postChanges(t *testing.T, ts *httptest.Server, changes []string) *http.Response {
	t.Helper()
	return do(t, "POST", ts.URL+"/api/lists/"+testID+"/changes", testToken, "", map[string][]string{"changes": changes})
}

func fetch(t *testing.T, ts *httptest.Server, since string) (int, []change, int) {
	t.Helper()
	res := do(t, "GET", ts.URL+"/api/lists/"+testID+"/changes?since="+since, testToken, "", nil)
	var got struct {
		Changes []change
		Latest  int
	}
	json.NewDecoder(res.Body).Decode(&got)
	return res.StatusCode, got.Changes, got.Latest
}

func enc(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestCursorValidation(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	for _, bad := range []string{"abc", "-1", "1.5"} {
		if code, _, _ := fetch(t, ts, bad); code != http.StatusBadRequest {
			t.Errorf("since=%s: got %d", bad, code)
		}
	}
	if code, changes, _ := fetch(t, ts, "5000"); code != http.StatusOK || len(changes) != 0 {
		t.Errorf("since past the end: got %d, %d changes", code, len(changes))
	}
}

func TestPaginationAndLimits(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	for b := 0; b < 13; b++ {
		batch := make([]string, 0, 200)
		for i := 0; i < 200 && b*200+i < 2500; i++ {
			batch = append(batch, enc(fmt.Sprint(b*200+i+1)))
		}
		if res := postChanges(t, ts, batch); res.StatusCode != http.StatusOK {
			t.Fatalf("batch %d: got %d", b, res.StatusCode)
		}
	}
	seen := 0
	for since := 0; ; {
		_, changes, latest := fetch(t, ts, fmt.Sprint(since))
		if latest != 2500 {
			t.Fatalf("latest: got %d", latest)
		}
		if len(changes) == 0 {
			break
		}
		if len(changes) > maxPerPage {
			t.Fatalf("page too big: %d", len(changes))
		}
		for _, c := range changes {
			seen++
			if c.Seq != seen || c.Data != enc(fmt.Sprint(seen)) {
				t.Fatalf("change %d out of order: %+v", seen, c)
			}
		}
		since = changes[len(changes)-1].Seq
	}
	if seen != 2500 {
		t.Fatalf("read %d changes", seen)
	}

	tooMany := make([]string, maxPerRequest+1)
	for i := range tooMany {
		tooMany[i] = "QUJD"
	}
	if res := postChanges(t, ts, tooMany); res.StatusCode != http.StatusBadRequest {
		t.Errorf("too many changes: got %d", res.StatusCode)
	}
	if res := postChanges(t, ts, []string{strings.Repeat("A", maxChange+4)}); res.StatusCode != http.StatusBadRequest {
		t.Errorf("oversized change: got %d", res.StatusCode)
	}
	big := make([]string, 20)
	for i := range big {
		big[i] = strings.Repeat("A", maxChange)
	}
	if res := postChanges(t, ts, big); res.StatusCode != http.StatusBadRequest {
		t.Errorf("oversized request: got %d", res.StatusCode)
	}
	if _, _, latest := fetch(t, ts, "0"); latest != 2500 {
		t.Errorf("rejected requests still stored something: latest %d", latest)
	}
}

func TestConcurrentWritesStayConsistent(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	create(t, ts)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				postChanges(t, ts, []string{enc(fmt.Sprintf("%d-%d-a", g, i)), enc(fmt.Sprintf("%d-%d-b", g, i))})
			}
		}(g)
	}
	wg.Wait()
	_, before, latest := fetch(t, ts, "0")
	if latest != 400 || len(before) != 400 {
		t.Fatalf("got latest %d and %d changes, want 400", latest, len(before))
	}
	ts.Close()

	ts2 := newTestServer(t, dir)
	_, after, _ := fetch(t, ts2, "0")
	if len(after) != len(before) {
		t.Fatalf("after reload: %d changes, before: %d", len(after), len(before))
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("change %d differs after reload: %+v vs %+v", i+1, before[i], after[i])
		}
	}
}

func TestConcurrentCreate(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			res := do(t, "POST", ts.URL+"/api/lists", "", testCode, map[string]string{"id": testID, "auth": testToken})
			codes <- res.StatusCode
		}()
	}
	a, b := <-codes, <-codes
	if a+b != http.StatusCreated+http.StatusConflict {
		t.Fatalf("got %d and %d, want one 201 and one 409", a, b)
	}
}

func TestFullList(t *testing.T) {
	old := maxLogBytes
	maxLogBytes = 12
	defer func() { maxLogBytes = old }()
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	if res := postChanges(t, ts, []string{"QUJD", "REVG"}); res.StatusCode != http.StatusOK {
		t.Fatalf("first post: got %d", res.StatusCode)
	}
	if res := postChanges(t, ts, []string{"R0hJ"}); res.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("post past the cap: got %d", res.StatusCode)
	}
}

// flakyLog simulates a disk that fails partway through a write.
type flakyLog struct {
	buf          bytes.Buffer
	failNext     bool
	truncateFail bool
}

func (f *flakyLog) WriteString(s string) (int, error) {
	if f.failNext {
		f.failNext = false
		half := s[:len(s)/2]
		f.buf.WriteString(half)
		return len(half), errors.New("disk full")
	}
	return f.buf.WriteString(s)
}
func (f *flakyLog) Sync() error { return nil }
func (f *flakyLog) Truncate(n int64) error {
	if f.truncateFail {
		return errors.New("read-only")
	}
	f.buf.Truncate(int(n))
	return nil
}
func (f *flakyLog) Close() error { return nil }

func TestFailedWriteIsRolledBack(t *testing.T) {
	f := &flakyLog{}
	l := &list{log: f, subs: map[chan int]struct{}{}}
	if _, err := l.add([]string{"QUJD"}); err != nil {
		t.Fatal(err)
	}
	f.failNext = true
	if _, err := l.add([]string{"REVG", "R0hJ"}); err == nil {
		t.Fatal("expected the failed write to be reported")
	}
	latest, err := l.add([]string{"SktM"})
	if err != nil || latest != 2 {
		t.Fatalf("after rollback: latest %d, err %v", latest, err)
	}
	if got := f.buf.String(); got != "QUJD\nSktM\n" {
		t.Fatalf("log on disk: %q", got)
	}

	f.failNext, f.truncateFail = true, true
	l.add([]string{"TU5P"})
	if _, err := l.add([]string{"UFFS"}); !errors.Is(err, errBroken) {
		t.Fatalf("after a failed rollback: got %v, want errBroken", err)
	}
}
