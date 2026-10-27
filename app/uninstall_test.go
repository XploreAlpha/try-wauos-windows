package main

import (
	"strings"
	"testing"
)

func TestUninstallKeyNameIsStablePerInstall(t *testing.T) {
	def := `C:\Users\me\AppData\Local\TryOmarchy`
	if got := uninstallKeyName(def, def); got != "TryOmarchy" {
		t.Fatalf("default install key: %q", got)
	}
	a := uninstallKeyName(`E:\Wau\TryOmarchy`, def)
	b := uninstallKeyName(`e:\omarchy\tryomarchy\`, def)
	if a != b || !strings.HasPrefix(a, "TryOmarchy-") || len(a) != len("TryOmarchy-")+8 {
		t.Fatalf("alternate install keys differ or are malformed: %q %q", a, b)
	}
	if uninstallKeyName(`D:\Other`, def) == a {
		t.Fatal("different folders must not share a key")
	}
	if got := uninstallDisplayName(`E:\Wau\TryOmarchy`, def); got != `Try Wau (E:\Wau\TryOmarchy)` {
		t.Fatalf("display name: %q", got)
	}
}

func TestUninstallCommandQuotesPaths(t *testing.T) {
	got := uninstallCommand(`E:\My Wau\TryOmarchy.exe`, `E:\My Wau`)
	if got != `"E:\My Wau\TryOmarchy.exe" -dir "E:\My Wau" -uninstall` {
		t.Fatalf("command: %s", got)
	}
	if displayVersion("v0.0.12-preview") != "0.0.12-preview" {
		t.Fatal("display version keeps the v prefix")
	}
}
