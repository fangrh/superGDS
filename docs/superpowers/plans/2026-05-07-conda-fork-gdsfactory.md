# Switch to Conda Base + Fork GDSFactory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `.venv`, clone the fork gdsfactory into the project, and install it in editable mode using the conda base Python, enabling local modifications to gdsfactory.

**Architecture:** Delete `.venv` (currently holds gdsfactory 9.41.0), clone `git@github.com:fangrh/gdsfactory.git` into a subdirectory, and `pip install -e .` using conda base Python (`/opt/anaconda3/bin/python`). The VS Code extension already reads the Python path from the Python extension settings, so no TS code changes are needed — only env setup and `.gitignore` updates.

**Tech Stack:** conda (base env, Python 3.12.7), pip editable install, git clone

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `.venv/` | Delete | Remove old virtual environment |
| `gdsfactory/` | Create (git clone) | Fork gdsfactory source for editable install |
| `.gitignore` | Modify | Ignore `gdsfactory/` subdirectory |

---

### Task 1: Remove `.venv`

**Files:**
- Delete: `.venv/` (entire directory)

- [ ] **Step 1: Deactivate any active venv**

If a venv is active in the shell, deactivate it first:

```bash
deactivate 2>/dev/null; echo "done"
```

- [ ] **Step 2: Delete the `.venv` directory**

```bash
rm -rf /Users/fangruihuan/Desktop/aalto/superGDS/.venv
```

- [ ] **Step 3: Verify deletion**

```bash
ls -la /Users/fangruihuan/Desktop/aalto/superGDS/.venv 2>&1
```

Expected: `No such file or directory`

- [ ] **Step 4: Commit**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
git rm -r --cached .venv 2>/dev/null; true
git add .gitignore
git commit -m "chore: remove .venv, switching to conda base env"
```

Note: `.venv/` is already in `.gitignore`, so this just ensures clean state.

---

### Task 2: Clone fork gdsfactory into project

**Files:**
- Create: `gdsfactory/` (git clone from fork)

The fork repo is `git@github.com:fangrh/gdsfactory.git`. We clone it into the project directory but **must keep it separate from the superGDS git repo** to avoid nested git issues.

- [ ] **Step 1: Clone the fork repo**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
git clone git@github.com:fangrh/gdsfactory.git gdsfactory
```

Expected: Clones into `gdsfactory/` subdirectory. This creates its own `.git` inside `gdsfactory/`, which is a separate repo.

- [ ] **Step 2: Verify clone**

```bash
ls /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory/setup.py /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory/pyproject.toml 2>/dev/null
```

Expected: At least one of `setup.py` or `pyproject.toml` exists (the install target).

- [ ] **Step 3: Verify gdsfactory has its own git, not nested into superGDS**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory && git remote -v
```

Expected: Shows `origin  git@github.com:fangrh/gdsfactory.git (fetch)`

Then:

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS && git status gdsfactory/
```

Expected: `gdsfactory/` shows as untracked (since we will add it to `.gitignore` in Task 3).

---

### Task 3: Add `gdsfactory/` to `.gitignore`**

**Files:**
- Modify: `.gitignore`

We must ignore the cloned `gdsfactory/` directory so it doesn't pollute the superGDS git repo.

- [ ] **Step 1: Add `gdsfactory/` to `.gitignore`**

Append `gdsfactory/` to the end of `.gitignore`:

```
gdsfactory/
```

- [ ] **Step 2: Verify git ignores it**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS && git status
```

Expected: `gdsfactory/` does NOT appear in untracked files.

- [ ] **Step 3: Commit**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
git add .gitignore
git commit -m "chore: ignore cloned gdsfactory directory"
```

---

### Task 4: Install fork gdsfactory in editable mode

**Files:**
- No file changes — pip install into conda base env

Uses conda base Python (`/opt/anaconda3/bin/python`) to install the cloned gdsfactory in editable mode (`-e .`). This means any changes to `gdsfactory/` source are immediately effective without reinstalling.

- [ ] **Step 1: Install gdsfactory in editable mode**

```bash
/opt/anaconda3/bin/python -m pip install -e /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory
```

This may take a while as gdsfactory has dependencies. Expected: Successfully installs gdsfactory and all its dependencies.

- [ ] **Step 2: Verify installation**

```bash
/opt/anaconda3/bin/python -c "import gdsfactory as gf; print(gf.__version__)"
```

Expected: Prints the version of the fork.

- [ ] **Step 3: Verify editable install (points to local clone)**

```bash
/opt/anaconda3/bin/python -m pip show gdsfactory
```

Expected: `Location: /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory/src` (or similar local path), and `Editable project location: /Users/fangruihuan/Desktop/aalto/superGDS/gdsfactory`.

- [ ] **Step 4: Run the fork detection script**

```bash
/opt/anaconda3/bin/python /Users/fangruihuan/Desktop/aalto/superGDS/python/detect_fork.py
```

Expected: `FORK=fork` or `FORK=upstream` depending on whether the fork has provenance features yet.

---

### Task 5: Update VS Code Python interpreter setting

**Files:**
- No file changes — VS Code user/workspace settings

The extension reads the Python path from the VS Code Python extension settings. Ensure it points to conda base.

- [ ] **Step 1: Set VS Code Python interpreter to conda base**

In VS Code:
1. Open Command Palette (`Cmd+Shift+P`)
2. Run `Python: Select Interpreter`
3. Select `/opt/anaconda3/bin/python` (conda base)

Or set in workspace `.vscode/settings.json`:

```json
{
  "python.defaultInterpreterPath": "/opt/anaconda3/bin/python"
}
```

- [ ] **Step 2: Verify the extension uses conda base Python**

Reload the VS Code window (`Cmd+Shift+P` → `Developer: Reload Window`), then run `superGDS: Detect gdsfactory version` from the command palette.

Expected: Shows the fork gdsfactory version.

---

## Self-Review

**Spec coverage:**
1. Remove `.venv` → Task 1
2. Use conda base Python → Tasks 4, 5
3. Clone fork gdsfactory → Task 2
4. Install with `-e .` → Task 4
5. Don't interfere with local git → Task 3 (gitignore), Task 2 (separate git repo)

**Placeholder scan:** No TBDs, TODOs, or vague steps. All commands and expected outputs are specified.

**Type consistency:** N/A — no code changes, only environment setup.
