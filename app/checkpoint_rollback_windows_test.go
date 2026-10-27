//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCheckpointRecoveryPortableLaunchers(t *testing.T) {
	dir, payload := portableRecoveryFixture(t)
	root := filepath.Dir(dir)
	digest, ok := installReceiptArtifactSHA256(filepath.Join(dir, "guest"), "rootfs.ext4")
	if !ok {
		t.Fatal("missing fixture identity")
	}
	disk := filepath.Join(dir, "vm", "disk.qcow2")
	if err := createQcow2Overlay(disk, "../guest/rootfs.ext4", 4<<20); err != nil {
		t.Fatal(err)
	}
	if err := writePortableBackingState(disk, digest); err != nil {
		t.Fatal(err)
	}
	if err := createRollbackRecoveryLaunchers(dir, filepath.Join(filepath.Dir(payload), "data")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Start Wau.cmd", "Settings.cmd"} {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || !strings.Contains(string(data), `"%~dp0TryOmarchy.exe" "-portable" "-no-update"`) {
			t.Fatalf("%s: %s %v", name, data, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, stableLauncherName)); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectInstallationDisk(dir); err != nil {
		t.Fatal(err)
	}
}

func TestPortableRecoveryBatchHelper(t *testing.T) {
	marker := os.Getenv("TRYOMARCHY_RECOVERY_ARGS_OUTPUT")
	if marker == "" {
		return
	}
	data, err := json.Marshal(os.Args[1:])
	if err != nil || os.WriteFile(marker, data, 0600) != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func TestPortableRecoveryBatchPreservesLiteralArguments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "portable recovery")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := copyLauncher(self, filepath.Join(root, stableLauncherName), os.Rename); err != nil {
		t.Fatal(err)
	}
	args := []string{"-test.run=^TestPortableRecoveryBatchHelper$", "--", "-portable", "-release", "https://example.invalid/%USERNAME%/a%20b?x=1&y=!literal!"}
	command, err := portableRecoveryCommand(args)
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "Run.cmd")
	if err := os.WriteFile(script, []byte(command), 0600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "arguments.json")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, system32("cmd.exe"), "/d", "/c", script)
	cmd.Env = append(os.Environ(), "TRYOMARCHY_RECOVERY_ARGS_OUTPUT="+marker)
	configureDiskTool(cmd)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("batch launcher: %v: %s", err, output)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	var actual []string
	if err := json.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, args) {
		t.Fatalf("batch changed arguments: %#v", actual)
	}
}
