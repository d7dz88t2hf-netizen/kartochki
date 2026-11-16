//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func acquireLock(path string) (func(), error) {
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	h, e := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if e != nil {
		return nil, e
	}
	return func() { syscall.CloseHandle(h) }, nil
}
func replaceFile(source, target string) error {
	src, e := syscall.UTF16PtrFromString(source)
	if e != nil {
		return e
	}
	dst, e := syscall.UTF16PtrFromString(target)
	if e != nil {
		return e
	}
	r, _, e := kernel32.NewProc("MoveFileExW").Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), 9)
	if r == 0 {
		return e
	}
	return nil
}
func showError(s string) {
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf16(s))), uintptr(unsafe.Pointer(utf16("Карточки"))), 0x10)
}
func closeNativeWindow() {
	if hwnd != 0 {
		user32.NewProc("PostMessageW").Call(hwnd, 0x8001, 0, 0)
	}
}
