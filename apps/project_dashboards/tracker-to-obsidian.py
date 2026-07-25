#!/usr/bin/env python3
"""
tracker-to-obsidian.py — Convert project roadmap trackers to Obsidian Markdown.

Usage:
  python3 tracker-to-obsidian.py <tracker-folder> [output-folder]

Examples:
  python3 tracker-to-obsidian.py deepsmoke-star-v2-tracker
  python3 tracker-to-obsidian.py luminescence-tracker "Obsidian Vault/Projects/Luminescence"

Output:
  A folder containing:
    - README.md (project dashboard with Dataview query)
    - Phase 1 – Name.md (one note per phase with full metadata and checklists)
    - systems/ (optional subfolder for system-level notes if expanded later)

Requirements:
  Python 3.7+ (no external packages)
"""

import json
import os
import sys
from pathlib import Path
from typing import Any


# ═════════════════════════════════════════════════════════════════════════════
# Configuration
# ═════════════════════════════════════════════════════════════════════════════

# YAML front matter template for Dataview
FRONT_MATTER_TEMPLATE = """---
project: "{project_name}"
phase: {phase_number}
phase_id: "{phase_id}"
title: "{phase_title}"
icon: "{phase_icon}"
total_tasks: {total_tasks}
systems:
{systems_yaml}
---
"""

# Priority → emoji mapping for visual scanning
PRIORITY_EMOJI = {
    "high": "🔴",
    "medium": "🟡",
    "low": "⚪",
    "critical": "💀",
}

# Status → emoji mapping
STATUS_EMOJI = {
    "planned": "📋",
    "in-progress": "🔄",
    "complete": "✅",
}


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════

def load_json(path: Path) -> dict[str, Any]:
    """Load a JSON file, returning empty dict on failure."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"  ⚠️  Skipping {path.name}: {e}")
        return {}


def make_front_matter(phase: dict[str, Any], phase_number: int, project_name: str) -> str:
    """Build Dataview-compatible YAML front matter for a phase."""
    systems_data = phase.get("systems", [])
    total_tasks = sum(len(sys.get("tasks", [])) for sys in systems_data)

    # Build systems list for YAML
    systems_yaml_lines = []
    for i, sys in enumerate(systems_data):
        tasks = sys.get("tasks", [])
        task_texts = [
            t if isinstance(t, str) else t.get("text", "")
            for t in tasks
        ]
        systems_yaml_lines.append(f'  - name: "{sys.get("name", f"System {i+1}")}"')
        systems_yaml_lines.append(f'    status: "{sys.get("status", "planned")}"')
        systems_yaml_lines.append(f'    priority: "{sys.get("priority", "medium")}"')
        systems_yaml_lines.append(f'    estimated_hours: {sys.get("estimatedHours", 0)}')
        deps = sys.get("dependencies", [])
        systems_yaml_lines.append(f'    dependencies: {json.dumps(deps)}')
        systems_yaml_lines.append(f'    task_count: {len(tasks)}')
        systems_yaml_lines.append(f'    notes: "{sys.get("notes", "").replace(chr(10), " ")}"')

    systems_yaml = "\n".join(systems_yaml_lines)

    return FRONT_MATTER_TEMPLATE.format(
        project_name=project_name,
        phase_number=phase_number,
        phase_id=phase.get("id", ""),
        phase_title=phase.get("title", ""),
        phase_icon=phase.get("icon", ""),
        total_tasks=total_tasks,
        systems_yaml=systems_yaml,
    )


def format_task(task: str | dict[str, Any]) -> str:
    """Format a task as a Markdown checkbox line with optional tags and notes."""
    if isinstance(task, str):
        text = task
        priority = None
        notes = None
        link = None
    else:
        text = task.get("text", "")
        priority = task.get("priority")
        notes = task.get("notes")
        link = task.get("link")

    line = f"- [ ] {text}"

    # Add priority tag
    if priority:
        emoji = PRIORITY_EMOJI.get(priority, "")
        line += f" #priority/{priority} {emoji}"

    # Add tutorial link
    if link:
        line += f" 🔗 [Tutorial]({link})"

    # Add notes as inline comment
    if notes:
        line += f" %% {notes} %%"

    return line


def build_phase_markdown(phase: dict[str, Any], phase_number: int, project_name: str) -> str:
    """Build a complete Markdown note for a single phase."""
    lines = []

    # Front matter
    lines.append(make_front_matter(phase, phase_number, project_name))

    # Title
    icon = phase.get("icon", "")
    title = phase.get("title", f"Phase {phase_number}")
    lines.append(f"# {icon} {title}\n")

    # Status badge
    statuses = set()
    priorities = set()
    for sys in phase.get("systems", []):
        if sys.get("status"):
            statuses.add(sys["status"])
        if sys.get("priority"):
            priorities.add(sys["priority"])

    status_line = " ".join(f"{STATUS_EMOJI.get(s, '')} `{s}`" for s in sorted(statuses) if s)
    priority_line = " ".join(f"{PRIORITY_EMOJI.get(p, '')} `{p}`" for p in sorted(priorities) if p)
    if status_line or priority_line:
        lines.append(f"{status_line}  {priority_line}\n")

    # Progress summary
    total = 0
    for sys in phase.get("systems", []):
        total += len(sys.get("tasks", []))
    lines.append(f"**{total} tasks** across {len(phase.get('systems', []))} systems\n")

    # Systems and tasks
    for sys in phase.get("systems", []):
        name = sys.get("name", "Unnamed System")
        status = sys.get("status", "planned")
        priority = sys.get("priority", "medium")
        notes = sys.get("notes", "")
        estimated = sys.get("estimatedHours", 0)
        deps = sys.get("dependencies", [])

        lines.append(f"## {name}\n")

        # Metadata line
        meta = []
        if status:
            meta.append(f"{STATUS_EMOJI.get(status, '')} `{status}`")
        if priority:
            meta.append(f"{PRIORITY_EMOJI.get(priority, '')} `{priority}`")
        if estimated:
            meta.append(f"⏱ {estimated}h")
        if deps:
            dep_links = ", ".join(f"[[Phase {d.split('_')[0]}]]" for d in deps)
            meta.append(f"🔗 Depends on: {dep_links}")

        if meta:
            lines.append(" • ".join(meta) + "\n")

        if notes:
            lines.append(f"> {notes}\n")

        # Tasks
        for task in sys.get("tasks", []):
            lines.append(format_task(task))

        lines.append("")  # blank line between systems

    # Footer with backlink
    lines.append("---\n")
    lines.append(f"← Back to [[{project_name} Dashboard|{project_name} Dashboard]]")

    return "\n".join(lines)


def build_dashboard_markdown(
    project_name: str,
    phases_data: list[dict[str, Any]],
    phases_filenames: list[str],
) -> str:
    """Build the master dashboard note with Dataview query."""
    lines = []

    lines.append("---")
    lines.append(f'project: "{project_name}"')
    lines.append(f'total_phases: {len(phases_data)}')
    lines.append("---\n")

    icon = phases_data[0].get("icon", "") if phases_data else ""
    lines.append(f"# {icon} {project_name} — Development Dashboard\n")

    lines.append("## 📊 Progress Overview\n")

    # Dataview query to aggregate progress
    lines.append("```dataview")
    lines.append("TABLE")
    lines.append("  icon as \"\",")
    lines.append("  title as \"Phase\",")
    lines.append("  total_tasks as \"Tasks\",")
    lines.append("  length(filter(this.file.tasks, (t) => t.completed)) as \"Done\",")
    lines.append("  round(length(filter(this.file.tasks, (t) => t.completed)) / length(this.file.tasks) * 100) as \"%\"")
    lines.append(f'FROM "Projects/{project_name}"')
    lines.append("WHERE phase AND file.name != \"README\"")
    lines.append("SORT phase ASC")
    lines.append("```\n")

    lines.append("## 📋 Phases\n")

    for i, phase in enumerate(phases_data):
        icon = phase.get("icon", "")
        title = phase.get("title", f"Phase {i+1}")
        systems = phase.get("systems", [])
        total = sum(len(s.get("tasks", [])) for s in systems)
        lines.append(f"- [[Phase {i+1} – {title}|{icon} Phase {i+1}: {title}]] ({total} tasks)")

    lines.append("\n## 🏷️ Tags Used")
    lines.append("`#priority/high` `#priority/medium` `#priority/low` `#priority/critical`")
    lines.append("`#status/planned` `#status/in-progress` `#status/complete`")

    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# Main Conversion Logic
# ═════════════════════════════════════════════════════════════════════════════

def convert_tracker(tracker_dir: Path, output_dir: Path) -> None:
    """Convert a single tracker folder to Obsidian Markdown."""
    data_dir = tracker_dir / "data"
    if not data_dir.exists():
        print(f"  ✗ No data/ folder found in {tracker_dir}")
        return

    manifest_path = data_dir / "phases.json"
    if not manifest_path.exists():
        print(f"  ✗ No phases.json found in {data_dir}")
        return

    manifest = load_json(manifest_path)
    if not manifest:
        print(f"  ✗ Could not load phases.json")
        return

    # Determine project name from folder name
    project_name = tracker_dir.name.replace("-tracker", "").replace("-", " ").title()
    if "v2" in tracker_dir.name.lower():
        project_name += " v2"

    # Load all phases
    phases_data = []
    for filename in manifest:
        phase_path = data_dir / filename
        phase_data = load_json(phase_path)
        if phase_data:
            phases_data.append(phase_data)

    if not phases_data:
        print(f"  ✗ No valid phases found")
        return

    # Create output directory
    project_output = output_dir / project_name
    project_output.mkdir(parents=True, exist_ok=True)

    # Write dashboard
    dashboard_md = build_dashboard_markdown(project_name, phases_data, manifest)
    with open(project_output / f"{project_name} Dashboard.md", "w", encoding="utf-8") as f:
        f.write(dashboard_md)
    print(f"  ✓ Dashboard: {project_name} Dashboard.md")

    # Write each phase
    for i, phase in enumerate(phases_data):
        phase_number = i + 1
        title = phase.get("title", f"Phase {phase_number}")
        filename = f"Phase {phase_number} – {title}.md"
        # Remove characters that are invalid in filenames
        safe_name = filename.replace("/", "-").replace("\\", "-").replace(":", " –")
        phase_md = build_phase_markdown(phase, phase_number, project_name)
        with open(project_output / safe_name, "w", encoding="utf-8") as f:
            f.write(phase_md)
        print(f"  ✓ Phase {phase_number}: {safe_name}")

    print(f"  ✅ Converted {len(phases_data)} phases to {project_output}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    tracker_dir = Path(sys.argv[1]).resolve()
    if not tracker_dir.exists():
        print(f"Error: '{tracker_dir}' not found.")
        sys.exit(1)

    if len(sys.argv) >= 3:
        output_dir = Path(sys.argv[2]).resolve()
    else:
        # Default: create "Obsidian Vault" alongside the tracker dir
        output_dir = tracker_dir.parent / "Obsidian Vault"

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Converting: {tracker_dir}")
    print(f"Output to:  {output_dir}")
    print()

    if tracker_dir.is_dir() and (tracker_dir / "data" / "phases.json").exists():
        # Single tracker
        convert_tracker(tracker_dir, output_dir)
    else:
        # Directory of trackers — convert all
        for subdir in sorted(tracker_dir.iterdir()):
            if subdir.is_dir() and (subdir / "data" / "phases.json").exists():
                print(f"\n📁 {subdir.name}")
                convert_tracker(subdir, output_dir)

    print(f"\n🎉 Done! Output in: {output_dir}")
    print("Next steps:")
    print("  1. Open Obsidian and point it to this output folder as a vault")
    print("  2. Install the 'Dataview' community plugin")
    print("  3. Open the Dashboard notes to see aggregated progress")


if __name__ == "__main__":
    main()
