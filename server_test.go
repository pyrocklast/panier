package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
