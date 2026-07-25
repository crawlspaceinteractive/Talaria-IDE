#!/usr/bin/env python3
"""
apply-progress.py — Patch Obsidian Markdown notes with exported tracker progress.

Usage:
  python3 apply-progress.py <tracker-progress.json> [vault-folder] [project-folder]

Examples:
  python3 apply-progress.py ~/Downloads/tracker-progress.json
  python3 apply-progress.py tracker-progress.json ~/Obsidian Vault ~/project_dashboards

Reads the JSON exported by export-progress.js and checks off the matching
checkboxes in the generated Obsidian Markdown phase notes.

Requirements:
  Python 3.7+ (no external packages)
"""

import json
import re
import sys
from pathlib import Path
from typing import Any


# ═════════════════════════════════════════════════════════════════════════════
# Mapping: localStorage keys → Obsidian note filenames
# ═════════════════════════════════════════════════════════════════════════════

# The export-progress.js uses storage keys like "deepsmoke_roadmap".
# The Obsidian vault folder names come from tracker-to-obsidian.py which
# strips "-tracker" and title-cases the remainder. We need to map back.

STORAGE_KEY_TO_VAULT_FOLDER = {
    "deepsmoke_roadmap":   "Deepsmoke",
    "froyo_roadmap":       "Froyo",
    "gztl_roadmap":        "Gztl",
    "goon_roadmap":        "Goon",
    "bmup_roadmap":        "Bmup",
    "pixelrealm_roadmap":  "Pixelrealm",
    "sixpac_roadmap":      "Sixpac",
    "wh_tekwar_roadmap":   "Wh Tekwar",
    "locnar_roadmap":      "Locnar",
    "computerror_roadmap": "Computerror",
    "brawl_roadmap":       "Brawl",
    "apex_roadmap":        "Apex",
    "cryptic_roadmap":     "Cryptic",
    "unreality_roadmap":   "Unreality",
    "luminescence_roadmap":"Luminescence",
    "gameofdeath_roadmap": "Gameofdeath",
    "blockbench_roadmap":  "Blockbench",
}

# Reverse: folder name → storage key
VAULT_FOLDER_TO_STORAGE_KEY = {v: k for k, v in STORAGE_KEY_TO_VAULT_FOLDER.items()}


def load_tracker_data(tracker_dir: Path) -> dict[str, list[dict]]:
    """
    Load all phase JSON data from a tracker directory.
    Returns { "phase1": { id, icon, title, systems: [...] }, ... }
    """
    data_dir = tracker_dir / "data"
    manifest_file = data_dir / "phases.json"
    if not manifest_file.exists():
        return {}

    with open(manifest_file, "r", encoding="utf-8") as f:
        phase_files = json.load(f)

    phases = {}
    for filename in phase_files:
        phase_path = data_dir / filename
        if phase_path.exists():
            with open(phase_path, "r", encoding="utf-8") as f:
                phase_data = json.load(f)
                phases[phase_data.get("id", filename.replace(".json", ""))] = phase_data

    return phases


def build_task_key_map(phases: dict[str, dict]) -> dict[str, tuple[str, int, int]]:
    """
    Build a mapping from localStorage task keys to (phase_id, system_index, task_index).

    The localStorage key format is: {phaseId}_{systemName}_{taskIndex}
    e.g. "phase1_1.1 Vehicle Movement Model_0"

    Returns dict like:
      { "phase1_1.1 Vehicle Movement Model_0": ("phase1", 0, 0), ... }
    """
    key_map = {}
    for phase_id, phase_data in phases.items():
        systems = phase_data.get("systems", [])
        for sys_idx, system in enumerate(systems):
            sys_name = system.get("name", "")
            tasks = system.get("tasks", [])
            for task_idx in range(len(tasks)):
                storage_key = f"{phase_id}_{sys_name}_{task_idx}"
                key_map[storage_key] = (phase_id, sys_idx, task_idx)
    return key_map


def find_phase_files(vault_dir: Path, folder_name: str) -> list[Path]:
    """Find all phase Markdown files in a vault project folder."""
    project_dir = vault_dir / folder_name
    if not project_dir.exists():
        return []
    return sorted(project_dir.glob("Phase *.md"))


def extract_phase_number(filename: str) -> int | None:
    """Extract the phase number from a filename like 'Phase 3 – ....md'."""
    match = re.match(r"Phase (\d+)", filename)
    if match:
        return int(match.group(1))
    return None


def patch_markdown(phase_file: Path, completed_keys: set[str], phases: dict[str, dict]) -> int:
    """
    Patch a single phase Markdown file, changing - [ ] to - [x] for completed tasks.

    Returns the number of checkboxes patched.
    """
    with open(phase_file, "r", encoding="utf-8") as f:
        lines = f.readlines()

    phase_num = extract_phase_number(phase_file.name)
    if phase_num is None:
        return 0

    # Find the phase data
    phase_id = f"phase{phase_num}"
    phase_data = phases.get(phase_id)
    if not phase_data:
        return 0

    systems = phase_data.get("systems", [])
    if not systems:
        return 0

    # Strategy: Walk through the markdown lines.
    # Track which system section we're in by matching ## headings.
    # Within each section, track task index by counting checkbox lines.
    # If the corresponding localStorage key is in completed_keys, check it.

    patched = 0
    current_sys_idx = -1
    task_idx_in_system = -1
    in_task_section = False

    for i, line in enumerate(lines):
        # Detect system headings: "## N.N System Name"
        heading_match = re.match(r"^## (.+)$", line.rstrip())
        if heading_match:
            heading_text = heading_match.group(1).strip()
            # Match heading to system by name
            for idx, sys in enumerate(systems):
                if sys.get("name", "") == heading_text:
                    current_sys_idx = idx
                    task_idx_in_system = -1
                    in_task_section = False
                    break
            else:
                # Heading doesn't match any system — might be a sub-section
                # Reset if it's a different kind of heading
                if not heading_text.startswith(("Tasks", "Summary")):
                    current_sys_idx = -1
                continue

        # Detect task sub-heading
        if line.strip() == "### Tasks":
            in_task_section = True
            task_idx_in_system = -1
            continue

        # Count checkbox lines within a system section
        if current_sys_idx >= 0 and re.match(r"^- \[[ x]\]", line):
            task_idx_in_system += 1
            task_idx = task_idx_in_system

            # Build the storage key for this task
            sys_name = systems[current_sys_idx].get("name", "")
            storage_key = f"{phase_id}_{sys_name}_{task_idx}"

            if storage_key in completed_keys:
                # Replace - [ ] with - [x]
                new_line = line.replace("- [ ]", "- [x]", 1)
                if new_line != line:
                    lines[i] = new_line
                    patched += 1

    if patched > 0:
        with open(phase_file, "w", encoding="utf-8") as f:
            f.writelines(lines)

    return patched


def find_project_dir(hint: Path) -> Path | None:
    """Search for the project_dashboards directory from a hint path."""
    candidates = [
        hint,
        hint.parent,
        hint.parent.parent,
    ]
    for candidate in candidates:
        if (candidate / "apex-tracker").exists():
            return candidate
    return None


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    progress_file = Path(sys.argv[1]).resolve()
    if not progress_file.exists():
        print(f"Error: '{progress_file}' not found.")
        sys.exit(1)

    # Parse arguments: progress_file [vault_folder] [project_dashboards]
    vault_dir = None
    project_dir = None

    if len(sys.argv) >= 3:
        vault_dir = Path(sys.argv[2]).resolve()
    if len(sys.argv) >= 4:
        project_dir = Path(sys.argv[3]).resolve()

    # Load the exported progress
    with open(progress_file, "r", encoding="utf-8") as f:
        progress = json.load(f)

    # Auto-detect vault location
    if vault_dir is None:
        for hint in [progress_file.parent, progress_file.parent / "Obsidian Vault", Path.cwd() / "Obsidian Vault"]:
            if hint.exists() and any(hint.iterdir()):
                vault_dir = hint
                break
        if vault_dir is None:
            print("Error: Could not find Obsidian Vault folder.")
            print("Pass the vault path as second argument.")
            sys.exit(1)

    # Auto-detect project_dashboards location
    if project_dir is None:
        project_dir = find_project_dir(vault_dir) or find_project_dir(progress_file)
    if project_dir is None:
        print("Error: Could not locate tracker data directories.")
        print("Pass the project_dashboards path as third argument:")
        print("  python3 apply-progress.py progress.json /path/to/vault /path/to/project_dashboards")
        sys.exit(1)

    print(f"Progress file: {progress_file}")
    print(f"Vault: {vault_dir}")
    print(f"Tracker data: {project_dir}")
    print()

    total_patched = 0
    total_tasks = 0

    for storage_key, tracker_data in progress.items():
        folder_name = STORAGE_KEY_TO_VAULT_FOLDER.get(storage_key)
        if not folder_name:
            print(f"  ⚠️  Unknown storage key: {storage_key}")
            continue

        completed_tasks = tracker_data.get("tasks", {})
        if not completed_tasks:
            continue

        completed_count = len(completed_tasks)
        total_tasks += completed_count

        # Load the tracker's JSON data
        tracker_dir = project_dir / f"{storage_key.replace('_roadmap', '-tracker')}"
        if not tracker_dir.exists():
            # Try alternate naming
            alt_names = [
                f"{folder_name.lower().replace(' ', '-')}-tracker",
                f"{storage_key.replace('_roadmap', '-tracker')}",
            ]
            for alt in alt_names:
                if (project_dir / alt).exists():
                    tracker_dir = project_dir / alt
                    break
            else:
                print(f"  ⚠️  Could not find tracker directory for {folder_name}")
                continue

        phases = load_tracker_data(tracker_dir)
        if not phases:
            print(f"  ⚠️  No phase data found for {folder_name}")
            continue

        # Find and patch the phase files
        phase_files = find_phase_files(vault_dir, folder_name)
        if not phase_files:
            print(f"  ⚠️  No phase Markdown files found in {vault_dir / folder_name}")
            continue

        tracker_patched = 0
        for phase_file in phase_files:
            patched = patch_markdown(phase_file, completed_tasks.keys(), phases)
            tracker_patched += patched

        total_patched += tracker_patched
        print(f"  ✓ {folder_name}: {tracker_patched}/{completed_count} tasks checked")

    print(f"\n🎉 Done! Patched {total_patched} checkboxes across all projects.")
    if total_tasks > total_patched:
        print(f"   ({total_tasks - total_patched} tasks had keys that didn't match — possibly old/renamed tasks)")


if __name__ == "__main__":
    main()
