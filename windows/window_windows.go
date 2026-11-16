//go:build windows

// Своё окно программы на Windows: окно Win32 + встроенный в Windows движок WebView2.
// Написано без cgo и без сторонних библиотек: WebView2 загружается из установленного
// в системе рантайма через официальный WebView2Loader.dll, COM-вызовы идут через таблицы методов.
// Если что-то пошло не так, программа откроется в Edge в режиме приложения.
package main

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"unsafe"
)

func init() { runtime.LockOSThread() } // окно и COM должны жить в главном потоке

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	pRegisterClassExW          = user32.NewProc("RegisterClassExW")
	pCreateWindowExW           = user32.NewProc("CreateWindowExW")
	pDefWindowProcW            = user32.NewProc("DefWindowProcW")
	pDestroyWindow             = user32.NewProc("DestroyWindow")
	pShowWindow                = user32.NewProc("ShowWindow")
	pUpdateWindow              = user32.NewProc("UpdateWindow")
	pGetMessageW               = user32.NewProc("GetMessageW")
	pTranslateMessage          = user32.NewProc("TranslateMessage")
	pDispatchMessageW          = user32.NewProc("DispatchMessageW")
	pPostQuitMessage           = user32.NewProc("PostQuitMessage")
	pGetClientRect             = user32.NewProc("GetClientRect")
	pLoadIconW                 = user32.NewProc("LoadIconW")
	pLoadCursorW               = user32.NewProc("LoadCursorW")
	pFindWindowW               = user32.NewProc("FindWindowW")
	pSetForegroundWindow       = user32.NewProc("SetForegroundWindow")
	pIsIconic                  = user32.NewProc("IsIconic")
	pSetProcessDpiAwarenessCtx = user32.NewProc("SetProcessDpiAwarenessContext")
	pGetDpiForSystem           = user32.NewProc("GetDpiForSystem")
	pGetModuleHandleW          = kernel32.NewProc("GetModuleHandleW")
	pCoInitializeEx            = ole32.NewProc("CoInitializeEx")
	pCreateSolidBrush          = gdi32.NewProc("CreateSolidBrush")
)

const (
	className       = "KartochkiWindow"
	wmDestroy       = 0x0002
	wmSize          = 0x0005
	wmSetFocus      = 0x0007
	swShow          = 5
	swRestore       = 9
	wsOverlappedWin = 0x00CF0000
	cwUseDefault    = 0x80000000
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type winMsg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	ptX, ptY int32
	lPrivate uint32
}

type winRect struct{ left, top, right, bottom int32 }

// COM-объект обработчика: указатель на таблицу методов + счётчик ссылок.
type comHandler struct {
	vtbl *[4]uintptr
	refs atomic.Uint32
	iid  syscall.GUID
}

//go:embed vendor/WebView2Loader.dll
var loaderBytes []byte

var (
	hwnd       uintptr
	controller uintptr
	webview    uintptr
	failed     bool
	keepAlive  []any
)

func newHandler(iid string, invoke func(this, hr, obj uintptr) uintptr) *comHandler {
	h := &comHandler{}
	h.iid = parseGUID(iid)
	unknown := parseGUID("{00000000-0000-0000-C000-000000000046}")
	h.refs.Store(1)
	vt := &[4]uintptr{
		syscall.NewCallback(func(this, riid, out uintptr) uintptr {
			if out == 0 {
				return 0x80004003
			}
			*(*uintptr)(unsafe.Pointer(out)) = 0
			if riid == 0 {
				return 0x80004002
			}
			requested := *(*syscall.GUID)(unsafe.Pointer(riid))
			if requested != h.iid && requested != unknown {
				return 0x80004002
			}
			*(*uintptr)(unsafe.Pointer(out)) = this
			h.refs.Add(1)
			return 0
		}),
		syscall.NewCallback(func(this uintptr) uintptr { return uintptr(h.refs.Add(1)) }),
		syscall.NewCallback(func(this uintptr) uintptr { return uintptr(h.refs.Add(^uint32(0))) }),
		syscall.NewCallback(invoke),
	}
	h.vtbl = vt
	keepAlive = append(keepAlive, h, vt)
	return h
}

// Вызов метода COM-объекта по номеру в таблице методов (0-2 — методы IUnknown).
func comCall(obj uintptr, index int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func utf16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

// Если программа уже открыта — показываем её окно.
func focusExisting() bool {
	h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(utf16(className))), 0)
	if h == 0 {
		return false
	}
	if r, _, _ := pIsIconic.Call(h); r != 0 {
		pShowWindow.Call(h, swRestore)
	}
	pSetForegroundWindow.Call(h)
	return true
}

// The SDK loader discovers Evergreen Runtime via Microsoft's supported API.
func loadWebView2(dir string) (*syscall.DLL, error) {
	cache, err := os.MkdirTemp(dir, "loader-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(cache, "WebView2Loader.dll")
	if err = os.WriteFile(path, loaderBytes, 0600); err != nil {
		os.RemoveAll(cache)
		return nil, err
	}
	written, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(written, loaderBytes) {
		os.RemoveAll(cache)
		return nil, syscall.EINVAL
	}
	dll, err := syscall.LoadDLL(path)
	if err != nil {
		os.RemoveAll(cache)
		return nil, err
	}
	loaderFolder = cache
	return dll, nil
}

var loaderFolder string

func comString(obj uintptr, method int) string {
	var p *uint16
	if comCall(obj, method, uintptr(unsafe.Pointer(&p))) != 0 || p == nil {
		return ""
	}
	defer ole32.NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(p)))
	return syscall.UTF16ToString(unsafe.Slice(p, utf16Length(p)))
}
func utf16Length(p *uint16) int {
	for n := 0; n < 32768; n++ {
		if *(*uint16)(unsafe.Add(unsafe.Pointer(p), n*2)) == 0 {
			return n
		}
	}
	return 0
}

func resize() {
	if controller == 0 {
		return
	}
	var r winRect
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	comCall(controller, 6, uintptr(unsafe.Pointer(&r))) // put_Bounds
}

func wndProc(h, m, wp, lp uintptr) uintptr {
	switch m {
	case 0x0010: // WM_CLOSE: finish the acknowledged save before destroying the view.
		if webview != 0 && ready() {
			comCall(webview, 29, uintptr(unsafe.Pointer(utf16("window.closeDesktop();null"))), 0)
			return 0
		}
	case 0x8001:
		pDestroyWindow.Call(h)
		return 0
	case 0x0024: // WM_GETMINMAXINFO
		info := (*[10]int32)(unsafe.Pointer(lp))
		info[6] = 420
		info[7] = 520
		return 0
	case 0x0113: // WM_TIMER: recover to browser fallback if asynchronous startup stalls.
		if wp == 1 {
			user32.NewProc("KillTimer").Call(h, 1)
			if !ready() {
				failed = true
				pPostQuitMessage.Call(0)
			}
		}
	case wmSize:
		resize()
	case wmSetFocus:
		if controller != 0 {
			comCall(controller, 12, 0) // MoveFocus(programmatic)
		}
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(h, m, wp, lp)
	return r
}

func nativeWindow(url, dir string) bool {
	// Если прошлый запуск своего окна упал — сразу открываемся через Edge.
	crashFlag := filepath.Join(dir, "window-starting")
	if exists(crashFlag) {
		_ = os.Remove(crashFlag)
		return false
	}
	loader, err := loadWebView2(dir)
	if err != nil {
		return false
	}
	defer func() { loader.Release(); os.RemoveAll(loaderFolder) }()
	create, err := loader.FindProc("CreateCoreWebView2EnvironmentWithOptions")
	if err != nil {
		return false
	}

	if pSetProcessDpiAwarenessCtx.Find() == nil {
		pSetProcessDpiAwarenessCtx.Call(^uintptr(3)) // PER_MONITOR_AWARE_V2 (-4)
	}
	hrCOM, _, _ := pCoInitializeEx.Call(0, 2)
	if int32(hrCOM) < 0 {
		return false
	}
	defer ole32.NewProc("CoUninitialize").Call()

	hInst, _, _ := pGetModuleHandleW.Call(0)
	icon, _, _ := pLoadIconW.Call(hInst, 1)
	cursor, _, _ := pLoadCursorW.Call(0, 32512)
	brush, _, _ := pCreateSolidBrush.Call(0x00D8E6EF) // бежевый фон, пока грузится страница
	wc := wndClassEx{
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     hInst,
		hIcon:         icon,
		hIconSm:       icon,
		hCursor:       cursor,
		hbrBackground: brush,
		lpszClassName: utf16(className),
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	if r, _, _ := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return false
	}
	dpi := uintptr(96)
	if pGetDpiForSystem.Find() == nil {
		if d, _, _ := pGetDpiForSystem.Call(); d != 0 {
			dpi = d
		}
	}
	hwnd, _, _ = pCreateWindowExW.Call(0,
		uintptr(unsafe.Pointer(utf16(className))), uintptr(unsafe.Pointer(utf16("Карточки"))),
		wsOverlappedWin, cwUseDefault, cwUseDefault, 1100*dpi/96, 820*dpi/96, 0, 0, hInst, 0)
	if hwnd == 0 {
		return false
	}
	pShowWindow.Call(hwnd, swShow)
	pUpdateWindow.Call(hwnd)
	user32.NewProc("SetTimer").Call(hwnd, 1, 20000, 0)

	_ = os.WriteFile(crashFlag, []byte("1"), 0o644)

	ctrlDone := newHandler("{6C4819F3-C9B7-4260-8127-C9F5BDE7F68C}", func(this, hr, ctrl uintptr) uintptr {
		if int32(hr) < 0 || ctrl == 0 {
			failed = true
			pPostQuitMessage.Call(0)
			return 0
		}
		controller = ctrl
		comCall(controller, 1) // AddRef: храним ссылку
		resize()
		comCall(controller, 4, 1)                                  // put_IsVisible(TRUE)
		comCall(controller, 25, uintptr(unsafe.Pointer(&webview))) // get_CoreWebView2
		if webview == 0 {
			failed = true
			pPostQuitMessage.Call(0)
			return 0
		}
		var settings uintptr
		if comCall(webview, 3, uintptr(unsafe.Pointer(&settings))) == 0 && settings != 0 {
			comCall(settings, 12, 0)
			comCall(settings, 16, 0)
			comCall(settings, 2)
		}
		allowed, _ := neturl(url)
		nav := newHandler("{9ADBE429-F36D-432B-9DDC-F8881FBD76E3}", func(this, sender, args uintptr) uintptr {
			raw := comString(args, 3)
			u, e := neturl(raw)
			if e != nil || u.Scheme != allowed.Scheme || u.Host != allowed.Host || (u.Path != "/" && u.Path != "/index.html") {
				comCall(args, 8, 1)
			}
			return 0
		})
		popup := newHandler("{D4C185FE-C81C-4989-97AF-2D3FA7AB5651}", func(this, sender, args uintptr) uintptr { comCall(args, 6, 1); return 0 })
		var navToken, popupToken int64
		comCall(webview, 7, uintptr(unsafe.Pointer(nav)), uintptr(unsafe.Pointer(&navToken)))
		comCall(webview, 44, uintptr(unsafe.Pointer(popup)), uintptr(unsafe.Pointer(&popupToken)))
		if int32(comCall(webview, 5, uintptr(unsafe.Pointer(utf16(url))))) < 0 {
			failed = true
			pPostQuitMessage.Call(0)
		}
		comCall(controller, 12, 0) // MoveFocus
		_ = os.Remove(crashFlag)
		return 0
	})
	envDone := newHandler("{4E8A3389-C9D8-4BD2-B6B5-124FEE6C1D4D}", func(this, hr, env uintptr) uintptr {
		if int32(hr) < 0 || env == 0 {
			failed = true
			pPostQuitMessage.Call(0)
			return 0
		}
		if int32(comCall(env, 3, hwnd, uintptr(unsafe.Pointer(ctrlDone)))) < 0 {
			failed = true
			pPostQuitMessage.Call(0)
		}
		return 0
	})

	userData := filepath.Join(os.Getenv("LocalAppData"), appName, "WebView2")
	_ = os.MkdirAll(userData, 0o755)
	hr, _, _ := create.Call(0, uintptr(unsafe.Pointer(utf16(userData))), 0, uintptr(unsafe.Pointer(envDone)))
	if int32(hr) < 0 {
		failed = true
	}

	var m winMsg
	for !failed {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	_ = os.Remove(crashFlag)
	if controller != 0 {
		comCall(controller, 24)
		comCall(controller, 2)
		controller = 0
	}
	if webview != 0 {
		comCall(webview, 2)
		webview = 0
	}
	if failed {
		pDestroyWindow.Call(hwnd)
		return false
	}
	return true
}

func neturl(raw string) (*url.URL, error) { return url.Parse(raw) }

func parseGUID(s string) syscall.GUID {
	b, err := hex.DecodeString(strings.ReplaceAll(strings.Trim(s, "{}"), "-", ""))
	if err != nil || len(b) != 16 {
		panic("invalid GUID")
	}
	g := syscall.GUID{Data1: binary.BigEndian.Uint32(b[:4]), Data2: binary.BigEndian.Uint16(b[4:6]), Data3: binary.BigEndian.Uint16(b[6:8])}
	copy(g.Data4[:], b[8:])
	return g
}
