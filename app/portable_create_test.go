package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"

	"testing"
)

func TestCreatePortableCopyRoundTrip(t *testing.T) {
	tool := os.Getenv("QEMU_IMG")
	var err error
	if tool == "" {
		tool, err = exec.LookPath("qemu-img")
		if err != nil {
			t.Skip("qemu-img unavailable")
		}
	}
	dir, _ := backupFixture(t)
	guest := filepath.Join(dir, "guest")
	if err := os.WriteFile(filepath.Join(guest, "build-spec.json"), []byte(`{"image":{"architecture":"x86_64"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	hashes := map[string]string{}
	for _, name := range installedGuestArtifacts {
		data, err := os.ReadFile(filepath.Join(guest, name))
		if err != nil {
			t.Fatal(err)
		}
		hashes[name] = testSHA256(data)
	}
	if err := writeInstallReceipt(guest, defaultReleaseURL, defaultSumsSHA256, installedGuestArtifacts, hashes); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "runtime")
	if err := os.WriteFile(filepath.Join(root, "bin", "qemu-system-x86_64w.exe"), []byte("test runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	sums, err := parseVerifiedSums(defaultSums, defaultSumsSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRuntimeReceipt(root, defaultReleaseURL, defaultSumsSHA256, sums[runtimeZip]); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(t.TempDir(), "launcher.exe")
	if err := os.WriteFile(launcher, []byte("test launcher"), 0700); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "portable")
	before, err := os.ReadFile(filepath.Join(dir, "vm", "disk.raw"))
	if err != nil {
		t.Fatal(err)
	}
	if err := createPortableCopyUsingTool(dir, destination, launcher, tool, nil); err != nil {
		t.Fatal(err)
	}
	disk, err := inspectInstallationDisk(filepath.Join(destination, "data"))
	if err != nil {
		t.Fatal(err)
	}
	if disk.Format != "qcow2" || disk.Backing != "" {
		t.Fatalf("portable disk has external dependencies: %+v", disk)
	}
	raw, cleanup, err := materializeInstallationDiskWithTool(t.TempDir(), disk, tool)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	got, err := os.ReadFile(raw)
	if err != nil {
		t.Fatal(err)
	}
	// QCOW2 virtual sizes are sector-aligned; the synthetic raw fixture is not.
	if !bytes.Equal(got[:len(before)], before) || !zeroBytes(got[len(before):]) {
		t.Fatal("portable copy lost user data")
	}
	for _, name := range []string{"Start Wau.cmd", "Settings.cmd", "TryOmarchy.exe", "payload/SHA256SUMS"} {
		if _, err := os.Stat(filepath.Join(destination, name)); err != nil {
			t.Fatal(err)
		}
	}
	current, _ := os.ReadFile(filepath.Join(dir, "vm", "disk.raw"))
	if !bytes.Equal(current, before) {
		t.Fatal("source changed")
	}
	if err := createPortableCopyUsingTool(dir, destination, launcher, tool, nil); err == nil {
		t.Fatal("replaced existing portable copy")
	}
	for _, mode := range []string{"cancel", "tool-failure", "pending-update"} {
		t.Run(mode, func(t *testing.T) {
			configureSetupCancellation(false)
			t.Cleanup(func() { configureSetupCancellation(false) })
			failedDestination := filepath.Join(t.TempDir(), "portable")
			selectedTool := tool
			if mode == "tool-failure" {
				selectedTool = filepath.Join(t.TempDir(), "missing-tool")
			}
			if mode == "pending-update" {
				pending := filepath.Join(dir, payloadUpdateStateFilename)
				if err := os.WriteFile(pending, []byte("pending"), 0600); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Remove(pending) })
			}
			err := createPortableCopyUsingTool(dir, failedDestination, launcher, selectedTool, func(int64, int64, string) {
				if mode == "cancel" {
					requestSetupCancel()
				}
			})
			if err == nil || (mode == "cancel" && !errors.Is(err, errSetupCancelled)) {
				t.Fatalf("unexpected failure result: %v", err)
			}
			entries, err := os.ReadDir(filepath.Dir(failedDestination))
			if err != nil || len(entries) != 0 {
				t.Fatalf("failure left output or staging: %v (%v)", entries, err)
			}
			current, err := os.ReadFile(filepath.Join(dir, "vm", "disk.raw"))
			if err != nil || !bytes.Equal(current, before) {
				t.Fatalf("failure modified the source: %v", err)
			}
		})
	}
}
