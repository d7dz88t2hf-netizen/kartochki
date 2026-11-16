package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	assets "kartochki"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const appName = "Kartochki"
const idleLimit = 3 * time.Minute

var seenMu sync.Mutex
var lastSeen = time.Now()
var uiReady bool

func touch()      { seenMu.Lock(); lastSeen = time.Now(); uiReady = true; seenMu.Unlock() }
func ready() bool { seenMu.Lock(); defer seenMu.Unlock(); return uiReady }

func main() {
	dir, err := os.UserConfigDir()
	if err != nil {
		fatalError("Не удалось открыть папку данных")
		return
	}
	dir = filepath.Join(dir, appName)
	if err = os.MkdirAll(dir, 0700); err != nil {
		fatalError("Нет доступа к папке данных")
		return
	}
	release, err := acquireLock(filepath.Join(dir, "app.lock"))
	if err != nil {
		if focusExisting() {
			return
		}
		b, readErr := os.ReadFile(filepath.Join(dir, "instance.json"))
		var instance struct{ URL string }
		if readErr == nil && json.Unmarshal(b, &instance) == nil && validLocalURL(instance.URL) {
			if openWindow(instance.URL) {
				return
			}
		}
		fatalError("Коллекция уже открыта. Закройте другой экземпляр приложения и повторите запуск.")
		return
	}
	defer release()
	logFile, err := os.OpenFile(filepath.Join(dir, "app.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err == nil {
		defer logFile.Close()
		log.SetOutput(logFile)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatalError("Не удалось запустить локальный интерфейс")
		return
	}
	defer ln.Close()
	bytes := make([]byte, 32)
	if _, err = rand.Read(bytes); err != nil {
		fatalError("Не удалось создать ключ сеанса")
		return
	}
	token := hex.EncodeToString(bytes)
	origin := "http://" + ln.Addr().String()
	address := origin + "/#" + token
	b, _ := json.Marshal(struct{ URL string }{address})
	if err = atomicWrite(filepath.Join(dir, "instance.json"), b); err != nil {
		fatalError("Не удалось сохранить параметры сеанса")
		return
	}
	defer os.Remove(filepath.Join(dir, "instance.json"))
	data := &store{path: filepath.Join(dir, "kartochki.json")}
	server := &http.Server{Handler: appHandler(data, origin, token), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Print(err)
		}
	}()
	defer server.Close()
	if nativeWindow(address, dir) {
		return
	}
	if !openWindow(address) {
		fatalError("Не удалось открыть окно. Установите Microsoft Edge или WebView2 Runtime.")
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		seenMu.Lock()
		idle := time.Since(lastSeen)
		seenMu.Unlock()
		if idle > idleLimit {
			return
		}
	}
}

func validLocalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Port() != "" && len(u.Fragment) == 64
}

func appHandler(data *store, origin, token string) http.Handler {
	files, _ := fs.Sub(assets.Web, "web")
	var revisionMu sync.Mutex
	revision := uint64(1)
	static := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'")
		if "http://"+r.Host != origin {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Kartochki-Token")), []byte(token)) != 1 {
				http.Error(w, "unauthorized", http.StatusForbidden)
				return
			}
			if source := r.Header.Get("Origin"); source != "" && source != origin {
				http.Error(w, "invalid origin", http.StatusForbidden)
				return
			}
			if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
				http.Error(w, "cross-site request", http.StatusForbidden)
				return
			}
			switch r.URL.Path {
			case "/api/data":
				if r.Method == http.MethodGet {
					revisionMu.Lock()
					defer revisionMu.Unlock()
					w.Header().Set("ETag", strconv.Quote(strconv.FormatUint(revision, 10)))
					w.Header().Set("Content-Type", "application/json; charset=utf-8")
					json.NewEncoder(w).Encode(data.load())
					return
				}
				if r.Method != http.MethodPut {
					w.Header().Set("Allow", "GET, PUT")
					http.Error(w, "method not allowed", 405)
					return
				}
				if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
					http.Error(w, "expected JSON", 415)
					return
				}
				body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDataBytes))
				if err != nil {
					http.Error(w, "request too large", 413)
					return
				}
				if err = validateData(body); err != nil {
					http.Error(w, "invalid collection", 400)
					return
				}
				revisionMu.Lock()
				defer revisionMu.Unlock()
				if r.Header.Get("If-Match") != strconv.Quote(strconv.FormatUint(revision, 10)) {
					http.Error(w, "collection changed", 409)
					return
				}
				if err = data.save(body); err != nil {
					log.Printf("save failed: %v", err)
					http.Error(w, "could not save collection", 500)
					return
				}
				revision++
				w.Header().Set("ETag", strconv.Quote(strconv.FormatUint(revision, 10)))
				touch()
				w.WriteHeader(http.StatusNoContent)
			case "/api/ping":
				if r.Method != http.MethodGet {
					http.Error(w, "method not allowed", 405)
					return
				}
				touch()
				w.WriteHeader(204)
			case "/api/bye":
				if r.Method != http.MethodPost {
					http.Error(w, "method not allowed", 405)
					return
				}
				seenMu.Lock()
				lastSeen = time.Now().Add(-idleLimit + 8*time.Second)
				seenMu.Unlock()
				w.WriteHeader(204)
			case "/api/close":
				if r.Method != http.MethodPost {
					http.Error(w, "method not allowed", 405)
					return
				}
				w.WriteHeader(204)
				closeNativeWindow()
			default:
				http.NotFound(w, r)
			}
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", 405)
			return
		}
		// Never expose file-server directory listings or redirect arbitrary paths.
		switch r.URL.Path {
		case "/", "/index.html", "/model.js", "/app.js", "/desktop.js", "/style.css":
			static.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func openWindow(address string) bool {
	app := "--app=" + address
	switch runtime.GOOS {
	case "windows":
		for _, path := range winBrowsers() {
			if exists(path) && exec.Command(path, app, "--window-size=1100,820").Start() == nil {
				return true
			}
		}
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", address).Start() == nil
	case "darwin":
		return exec.Command("open", address).Start() == nil
	default:
		return exec.Command("xdg-open", address).Start() == nil
	}
}
func winBrowsers() []string {
	var paths []string
	for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
		if root != "" {
			for _, parts := range [][]string{{"Microsoft", "Edge", "Application", "msedge.exe"}, {"Google", "Chrome", "Application", "chrome.exe"}} {
				paths = append(paths, filepath.Join(append([]string{root}, parts...)...))
			}
		}
	}
	return paths
}
func exists(path string) bool   { _, err := os.Stat(path); return err == nil }
func fatalError(message string) { log.Print(message); showError(fmt.Sprint(message)) }
