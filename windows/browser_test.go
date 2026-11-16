package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBrowser(t *testing.T) {
	if os.Getenv("BROWSER_TESTS") != "1" {
		t.Skip("set BROWSER_TESTS=1 and install Playwright")
	}
	dir := t.TempDir()
	s := &store{path: filepath.Join(dir, "data.json")}
	server := httptest.NewUnstartedServer(http.NotFoundHandler())
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server.Listener.Close()
	server.Listener = ln
	origin := "http://" + ln.Addr().String()
	token := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	server.Config.Handler = appHandler(s, origin, token)
	server.Start()
	defer server.Close()
	command := exec.Command("node", "../tests/browser.cjs")
	command.Env = append(os.Environ(), "TEST_URL="+origin+"/#"+token, "TEST_DATA="+s.path)
	out, e := command.CombinedOutput()
	t.Log(string(out))
	if e != nil {
		t.Fatal(e)
	}
}
