package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var sample = []byte(`{"app":"kartochki","version":1,"decks":{"d1":{"id":"d1","name":"Test","cards":[{"id":"c1","front":"Q","back":"A"}]}},"settings":{"theme":"light","newPerDay":20}}`)

func TestStorageRecovery(t *testing.T) {
	s := &store{path: filepath.Join(t.TempDir(), "kartochki.json")}
	if s.load().Data != nil {
		t.Fatal("not empty")
	}
	if e := s.save(sample); e != nil {
		t.Fatal(e)
	}
	second := bytes.ReplaceAll(sample, []byte(`"Q"`), []byte(`"Q2"`))
	if e := s.save(second); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(s.path + ".bak")
	if !bytes.Equal(b, sample) {
		t.Fatal("wrong backup")
	}
	malformed := bytes.ReplaceAll(sample, []byte(`"theme":"light"`), []byte(`"theme":"invalid"`))
	if e := s.save(malformed); e == nil {
		t.Fatal("accepted corrupt settings")
	}
	if e := s.save([]byte(`{}`)); e == nil {
		t.Fatal("accepted invalid data")
	}
	b, _ = os.ReadFile(s.path)
	if !bytes.Equal(b, second) {
		t.Fatal("destroyed valid data")
	}
	os.WriteFile(s.path, []byte("broken"), 0600)
	boot := s.load()
	if boot.Notice == "" || !bytes.Equal(boot.Data, sample) {
		t.Fatal("no recovery")
	}
	if e := s.save(sample); e != nil {
		t.Fatal(e)
	}
	corrupt, _ := filepath.Glob(s.path + ".corrupt-*")
	if len(corrupt) != 1 {
		t.Fatal("damaged data not preserved")
	}
	os.WriteFile(s.path, []byte("broken"), 0600)
	os.WriteFile(s.path+".bak", []byte("broken"), 0600)
	if s.load().Error == "" {
		t.Fatal("no explicit read error")
	}
}
func TestAtomicConcurrentWrites(t *testing.T) {
	s := &store{path: filepath.Join(t.TempDir(), "data.json")}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := s.save(sample); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	b, e := os.ReadFile(s.path)
	if e != nil || !json.Valid(b) {
		t.Fatal("invalid final file", e)
	}
}
func TestAPIIsolationAndConflicts(t *testing.T) {
	s := &store{path: filepath.Join(t.TempDir(), "data.json")}
	h := appHandler(s, "http://127.0.0.1:5555", "secret")
	call := func(method, path, body, token, origin, host, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:5555"+path, strings.NewReader(body))
		r.Host = host
		r.Header.Set("X-Kartochki-Token", token)
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("If-Match", etag)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, x := range []struct{ token, origin, host string }{{"", "", "127.0.0.1:5555"}, {"secret", "https://evil.test", "127.0.0.1:5555"}, {"secret", "", "evil.test:5555"}} {
		w := call("PUT", "/api/data", string(sample), x.token, x.origin, x.host, `"1"`)
		if w.Code != 403 {
			t.Fatal("unauthorized write", w.Code)
		}
	}
	get := call("GET", "/api/data", "", "secret", "", "127.0.0.1:5555", "")
	tag := get.Header().Get("ETag")
	if tag == "" {
		t.Fatal("missing revision")
	}
	put := call("PUT", "/api/data", string(sample), "secret", "", "127.0.0.1:5555", tag)
	if put.Code != 204 {
		t.Fatal(put.Code, put.Body.String())
	}
	stale := call("PUT", "/api/data", string(sample), "secret", "", "127.0.0.1:5555", tag)
	if stale.Code != 409 {
		t.Fatal("lost update not prevented")
	}
	for _, x := range []struct {
		method, path string
		status       int
	}{{"DELETE", "/api/data", 405}, {"GET", "/web/", 404}, {"GET", "/", 200}} {
		w := call(x.method, x.path, "", "secret", "", "127.0.0.1:5555", "")
		if w.Code != x.status {
			t.Fatal(x, w.Code)
		}
		if w.Header().Get("Content-Security-Policy") == "" {
			t.Fatal("missing CSP")
		}
	}
	_ = http.MethodGet
}
func TestLock(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")
	release, e := acquireLock(p)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	if release2, e := acquireLock(p); e == nil {
		release2()
		t.Fatal("second instance acquired lock")
	}
}
