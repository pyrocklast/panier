package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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

// wsDial opens a live-update WebSocket by hand, as a browser would.
func wsDial(t *testing.T, ts *httptest.Server, protocols string) (net.Conn, *bufio.Reader, string) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	fmt.Fprintf(conn, "GET /api/lists/%s/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: %s\r\n\r\n", testID, protocols)
	r := bufio.NewReader(conn)
	res, err := http.ReadResponse(r, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		return conn, r, res.Status
	}
	if got := res.Header.Get("Sec-WebSocket-Accept"); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept key: %q", got)
	}
	if got := res.Header.Get("Sec-WebSocket-Protocol"); got != "panier" {
		t.Fatalf("protocol: %q", got)
	}
	return conn, r, res.Status
}

// serverFrame reads one unmasked frame sent by the server.
func serverFrame(t *testing.T, conn net.Conn, r *bufio.Reader) (byte, string) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		t.Fatal(err)
	}
	p := make([]byte, h[1]&0x7f)
	io.ReadFull(r, p)
	return h[0] & 0x0f, string(p)
}

// clientFrame sends one masked frame, as browsers do.
func clientFrame(conn net.Conn, op byte, payload string) {
	mask := []byte{1, 2, 3, 4}
	b := []byte{0x80 | op, 0x80 | byte(len(payload))}
	b = append(b, mask...)
	for i := 0; i < len(payload); i++ {
		b = append(b, payload[i]^mask[i%4])
	}
	conn.Write(b)
}

func TestLiveUpdates(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)

	if _, _, status := wsDial(t, ts, "panier"); !strings.HasPrefix(status, "401") {
		t.Fatalf("no token: %s", status)
	}
	other := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	if _, _, status := wsDial(t, ts, "panier, "+other); !strings.HasPrefix(status, "401") {
		t.Fatalf("wrong token: %s", status)
	}
	res := do(t, "GET", ts.URL+"/api/lists/"+testID+"/live", testToken, "", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token in a header instead of a subprotocol: got %d", res.StatusCode)
	}

	conn, r, status := wsDial(t, ts, "panier, "+testToken)
	if !strings.HasPrefix(status, "101") {
		t.Fatalf("handshake: %s", status)
	}
	if op, msg := serverFrame(t, conn, r); op != opText || msg != "0" {
		t.Fatalf("first message: %d %q", op, msg)
	}
	postChanges(t, ts, []string{"QUJD"})
	if _, msg := serverFrame(t, conn, r); msg != "1" {
		t.Fatalf("after a change: %q", msg)
	}
	clientFrame(conn, opText, "ping")
	if _, msg := serverFrame(t, conn, r); msg != "pong" {
		t.Fatalf("keepalive: %q", msg)
	}
	clientFrame(conn, opPing, "hi")
	if op, msg := serverFrame(t, conn, r); op != opPong || msg != "hi" {
		t.Fatalf("protocol ping: %d %q", op, msg)
	}
	clientFrame(conn, opClose, "")
	if op, _ := serverFrame(t, conn, r); op != opClose {
		t.Fatalf("close: got opcode %d", op)
	}
}

// The phone closing as a change comes in: the change must not follow the close.
func TestNothingAfterClose(t *testing.T) {
	a, b := net.Pipe()
	got := make(chan []byte)
	go func() { all, _ := io.ReadAll(b); got <- all }()
	ws := &wsConn{conn: a}
	if err := ws.send(opClose, nil); err != nil {
		t.Fatal(err)
	}
	if ws.send(opText, []byte("2")) == nil {
		t.Fatal("a frame went after the close")
	}
	a.Close()
	if all := <-got; !bytes.Equal(all, wsFrame(opClose, nil)) {
		t.Fatalf("sent %x", all)
	}
}

func TestLiveNeedsWebSocket(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	req, _ := http.NewRequest("GET", ts.URL+"/api/lists/"+testID+"/live", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "panier, "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("plain request: got %d", res.StatusCode)
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

func TestFilesAreGzipped(t *testing.T) {
	js := strings.Repeat("const a = 1;\n", 200)
	web := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Panier</title>")}, "app.js": {Data: []byte(js)}, "icon.png": {Data: []byte("png")}}
	ts := httptest.NewServer(staticFiles(web))
	defer ts.Close()
	tr := &http.Transport{DisableCompression: true} // see the response as sent
	get := func(path, enc string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		res, err := tr.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	res, body := get("/app.js", "gzip, br")
	if res.Header.Get("Content-Encoding") != "gzip" || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("app.js: %v", res.Header)
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if plain, _ := io.ReadAll(zr); string(plain) != js || len(body) >= len(js)/4 {
		t.Fatalf("app.js: %d bytes gzipped, decompressing to the file: %v", len(body), string(plain) == js)
	}
	if res, body := get("/app.js", ""); res.Header.Get("Content-Encoding") != "" || string(body) != js {
		t.Fatalf("without gzip: %v", res.Header)
	}
	if res, _ := get("/", "gzip"); res.Header.Get("Content-Encoding") != "gzip" || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("the page: %v", res.Header)
	}
	if res, _ := get("/icon.png", "gzip"); res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("an image is sent as it is: %v", res.Header)
	}
}

func TestCreateByVouching(t *testing.T) {
	ts := newTestServer(t, t.TempDir())
	create(t, ts)
	token := func(b byte) string { return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{b}, 32)) }
	id := func(b byte) string { return strings.Repeat(fmt.Sprintf("%02x", b), 16) }
	vouch := func(by, byToken string, n byte) int {
		return do(t, "POST", ts.URL+"/api/lists", byToken, "", map[string]string{"id": id(n), "auth": token(n), "by": by}).StatusCode
	}
	if got := vouch(testID, token(9), 0x10); got != http.StatusForbidden {
		t.Fatalf("wrong voucher token: got %d", got)
	}
	if got := vouch(id(0x99), testToken, 0x10); got != http.StatusForbidden {
		t.Fatalf("unknown voucher: got %d", got)
	}
	if got := vouch(testID, "", 0x10); got != http.StatusBadRequest {
		t.Fatalf("no voucher token: got %d", got)
	}
	if got := vouch(testID, testToken, 0x10); got != http.StatusCreated {
		t.Fatalf("vouched by the first list: got %d", got)
	}
	// A list made by vouching can vouch in turn, within the same family's budget.
	if got := vouch(id(0x10), token(0x10), 0x11); got != http.StatusCreated {
		t.Fatalf("vouched by a vouched list: got %d", got)
	}
	for n := byte(0x12); n < 0x10+byte(maxFamily); n++ {
		if got := vouch(id(0x11), token(0x11), n); got != http.StatusCreated {
			t.Fatalf("list %d of the family: got %d", n-0x0f, got)
		}
	}
	if got := vouch(testID, testToken, 0xf0); got != http.StatusForbidden {
		t.Fatalf("one more than the family holds: got %d", got)
	}
	// Another list started with the setup code has a budget of its own.
	if res := do(t, "POST", ts.URL+"/api/lists", "", testCode, map[string]string{"id": id(0xe0), "auth": token(0xe0)}); res.StatusCode != http.StatusCreated {
		t.Fatalf("second setup list: got %d", res.StatusCode)
	}
	if got := vouch(id(0xe0), token(0xe0), 0xe1); got != http.StatusCreated {
		t.Fatalf("vouched in the second family: got %d", got)
	}
}

func TestCloseList(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)
	create(t, ts)
	list := ts.URL + "/api/lists/" + testID
	do(t, "POST", list+"/changes", testToken, "", map[string][]string{"changes": {"QUJD"}})

	conn, r, _ := wsDial(t, ts, "panier, "+testToken)
	if op, msg := serverFrame(t, conn, r); op != opText || msg != "1" {
		t.Fatalf("first message: %d %q", op, msg)
	}
	if res := do(t, "DELETE", list, base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32)), "", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("close with a wrong token: got %d", res.StatusCode)
	}
	if res := do(t, "DELETE", list, testToken, "", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("close: got %d", res.StatusCode)
	}
	if op, msg := serverFrame(t, conn, r); op != opText || msg != "closed" {
		t.Fatalf("listeners are told: %d %q", op, msg)
	}
	if op, _ := serverFrame(t, conn, r); op != opClose {
		t.Fatalf("then the connection closes: got opcode %d", op)
	}
	for _, m := range []string{"GET", "POST"} {
		if res := do(t, m, list+"/changes", testToken, "", map[string][]string{"changes": {"REVG"}}); res.StatusCode != http.StatusGone {
			t.Fatalf("%s after closing: got %d", m, res.StatusCode)
		}
	}
	if res := do(t, "DELETE", list, testToken, "", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("closing again: got %d", res.StatusCode)
	}
	if res := do(t, "POST", ts.URL+"/api/lists", testToken, "", map[string]string{"id": strings.Repeat("cd", 16), "auth": testToken, "by": testID}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("a closed list can't vouch: got %d", res.StatusCode)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "lists", testID, "log")); len(b) != 0 {
		t.Fatalf("the changes are deleted, got %q", b)
	}

	// Still closed after a restart.
	ts2 := newTestServer(t, dir)
	if res := do(t, "GET", ts2.URL+"/api/lists/"+testID+"/changes", testToken, "", nil); res.StatusCode != http.StatusGone {
		t.Fatalf("after a restart: got %d", res.StatusCode)
	}
}
