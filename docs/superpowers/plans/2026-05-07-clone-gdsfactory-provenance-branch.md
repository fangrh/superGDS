# Clone GDSFactory Fork (Provenance Branch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone the fork gdsfactory `feat/provenance-tracking` branch into the project as an independent git repo and install it in editable mode.

**Architecture:** The fork lives in `gdsfactory/` as a standalone git repo (ignored by superGDS via `.gitignore`). This allows independent development on the fork while the superGDS extension references it via editable pip install. The `feat/provenance-tracking` branch provides `gdsfactory.provenance_inject` module required by the extension for full provenance support.

**Tech Stack:** git, conda base Python (`/opt/anaconda3/bin/python` on macOS, `$env:CONDA_PREFIX/python` on Windows), pip editable install

---

## Pre-flight

- **Branch:** `feat/provenance-tracking` — the only branch with the provenance module
- **Remote:** `git@github.com:fangrh/gdsfactory.git`
- **Target dir:** `gdsfactory/` (already in `.gitignore`)

---

### Task 1: Clone fork with provenance branch

**Files:**
- Create: `gdsfactory/` (git clone)

- [ ] **Step 1: Clone the fork with the provenance branch**

```bash
git clone -b feat/provenance-tracking git@github.com:fangrh/gdsfactory.git gdsfactory
```

Expected: Clones into `gdsfactory/` with `feat/provenance-tracking` checked out.

- [ ] **Step 2: Verify the correct branch is active**

```bash
git -C gdsfactory branch
```

Expected: `* feat/provenance-tracking`

- [ ] **Step 3: Verify provenance module exists**

```bash
ls gdsfactory/gdsfactory/provenance_inject.py
```

Expected: File exists. Also check `gdsfactory/gdsfactory/provenance.py` if present.

- [ ] **Step 4: Verify gdsfactory is an independent git repo**

```bash
git -C gdsfactory remote -v
```

Expected: Shows `origin git@github.com:fangrh/gdsfactory.git`

- [ ] **Step 5: Verify superGDS git ignores it**

```bash
git status gdsfactory/
```

Expected: `gdsfactory/` does NOT appear (already in `.gitignore`).

---

### Task 2: Install in editable mode

**Files:**
- Modify: none (only pip state changes)

- [ ] **Step 1: Find conda base Python**

Windows:
```powershell
$condaPython = & conda info --base | ForEach-Object { Join-Path $_ "python.exe" }
$condaPython
```

macOS:
```bash
/opt/anaconda3/bin/python --version
```

- [ ] **Step 2: Install gdsfactory in editable mode**

Windows:
```powershell
& $condaPython -m pip install -e D:\gds_argo\Gdslab\superGDS\gdsfactory
```

macOS:
```bash
/opt/anaconda3/bin/python -m pip install -e gdsfactory
```

- [ ] **Step 3: Verify the import resolves to the local clone**

Windows:
```powershell
& $condaPython -c "import gdsfactory as gf; print(gf.__file__)"
```

macOS:
```bash
/opt/anaconda3/bin/python -c "import gdsfactory as gf; print(gf.__file__)"
```

Expected: Path points into the local `gdsfactory/gdsfactory/__init__.py`.

- [ ] **Step 4: Verify provenance module is importable**

Windows:
```powershell
& $condaPython -c "from gdsfactory import provenance_inject; print('OK')"
```

macOS:
```bash
/opt/anaconda3/bin/python -c "from gdsfactory import provenance_inject; print('OK')"
```

Expected: Prints `OK` with no errors.

- [ ] **Step 5: Reload VS Code and run detect command**

Reload: `Ctrl+Shift+P` → `Developer: Reload Window` (Windows) / `Cmd+Shift+P` (macOS)

Then: `Ctrl+Shift+P` → `superGDS: Detect gdsfactory version`

Expected: Shows "Fork gdsfactory detected — full provenance support".

---

### Task 3: Commit the changelog note

- [ ] **Step 1: Commit**

```bash
git add docs/superpowers/plans/2026-05-07-clone-gdsfactory-provenance-branch.md
git commit -m "docs: add clone gdsfactory provenance branch plan"
```
