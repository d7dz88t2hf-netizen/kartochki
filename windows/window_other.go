//go:build !windows

package main

func focusExisting() bool               { return false }
func nativeWindow(url, dir string) bool { return false }
