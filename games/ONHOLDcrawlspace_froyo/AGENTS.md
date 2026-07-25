# CRAWLSPACE ENGINE — AGENT DEVELOPMENT MANUAL

## Purpose
This document exists to guide future AI agents, contributors, and developers working on Crawlspace Engine.

Its purpose is simple:

- Preserve working systems.
- Preserve developer intent.
- Preserve content compatibility.
- Help build games.
- Avoid destructive or unnecessary changes.

This document should be read before making architectural recommendations, refactors, or large code changes.

---

# What Crawlspace Engine Is
Crawlspace Engine is a content-focused retro 3D game engine and development platform.

It is designed around:

- Rapid game development
- Genre portability
- Asset portability
- Modding-inspired workflows
- Deterministic systems
- Retro rendering aesthetics
- Minimal runtime complexity

The engine is intended to support multiple game genres without requiring a new engine architecture for each project.

Examples include:

- FPS projects
- Platformers
- Puzzle games
- Beat-em-ups
- Procedural world projects
- Experimental prototypes

Changing genres should primarily involve changing content, assets, data, and gameplay logic rather than rebuilding the engine.

---

# Core Philosophy

## Build Games
The primary objective is:

Build games.

Not:

- Build frameworks
- Build abstractions
- Build architecture diagrams
- Chase trends

Every recommendation should support game development.

## Working Code Has Value
Working code should be respected.

A system does not require replacement simply because:

- It is old
- It is unconventional
- It is large
- It differs from common patterns
- Another implementation exists

Refactoring requires a demonstrated benefit.

## Practical Solutions Beat Fashionable Solutions
The engine values:

- Practicality
- Reliability
- Speed of iteration

Above:

- Architectural purity
- Trend adoption
- Framework conformity

## Content Portability Matters
One of the core goals of Crawlspace is:

Build content once.

Reuse it many times.

Systems should preserve:

- Assets
- Scenes
- Exports
- World data
- Metadata
- Tools

Whenever possible.

## Genre Portability Matters
Genre flexibility is intentional.

The engine is expected to support radically different game types.

Future agents should never assume:

- The current project defines the future project.
- A feature is useless because it is not used by the current game.

Many systems exist specifically to support future genres.

---

# Source First Rule
Before making claims about the project:

1. Read the relevant files.
2. Read the relevant documentation.
3. Read the user request again.
4. Verify assumptions against implementation.

The code is the source of truth.

Do not infer behavior from:

- File names
- Folder names
- Project structure
- Naming conventions
- Framework expectations
- Prior experience

If you have not read the relevant file:

State that clearly.

Do not guess.

---

# No Ghost Analysis Rule
Do not analyze files you have not read.

Do not summarize code you have not inspected.

Do not describe systems you have not verified.

Do not invent implementation details.

Do not fill gaps with assumptions.

Unknown is preferable to incorrect.

---

# Evidence Rule
Do not invent evidence.

Do not fabricate bugs.

Do not manufacture performance issues.

Do not claim architectural problems without proof.

Claims should be supported by:

- Source code
- Runtime behavior
- Logs
- Profiling data
- Error messages
- Reproduction steps
- User-provided evidence

If evidence is incomplete:

- State what is known.
- State what is unknown.
- Request clarification when necessary.

---

# Human Authority Rule
The developer is the authoritative source of intent.

The code explains what exists.

The developer explains why it exists.

If the developer states a behavior is intentional:

- Do not override intent.
- Do not assume a bug.
- Do not argue from convention.
- Do not substitute industry trends for project requirements.

The human has final authority.

Always.

---

# Scope Rule
Only solve the problem requested.

Do not expand scope.

Do not redesign unrelated systems.

Do not perform speculative refactors.

Do not turn:

- A bug fix into a rewrite.
- A feature request into a rewrite.
- A question into a migration proposal.

Fix the problem.

Do not fix the project.

---

# Architecture Rule
Crawlspace is not required to resemble:

- Unity
- Unreal
- Godot
- React
- Enterprise software
- Modern web frameworks

Differences from those systems are not evidence of flaws.

Many architectural choices are intentional.

---

# Large File Rule
Large files are not evidence of poor design.

Large files are not evidence of technical debt.

Before recommending file splits:

Demonstrate a concrete benefit.

Examples:

- Reduced maintenance burden
- Actual coupling issues
- Measured development slowdown

Personal preference is not sufficient justification.

---

# Refactoring Rule
Before proposing a refactor ask:

1. What problem does this solve?
2. Is the problem real?
3. Is there evidence?
4. Does the benefit exceed the risk?

If these questions cannot be answered:

Do not refactor.

---

# Safe Refactors
Generally safe:

- Bug fixes
- Performance fixes
- Documentation improvements
- Serialization improvements
- Editor quality-of-life improvements
- Error handling improvements
- Testing improvements

---

# Dangerous Refactors
Require strong justification:

- Save format changes
- Export format changes
- Scene format changes
- Asset pipeline changes
- Renderer rewrites
- Physics rewrites
- World generation rewrites
- Serialization rewrites
- Architecture migrations

---

# Compatibility Rule
Compatibility is valuable.

Preserve whenever possible:

- Scene files
- Export files
- Asset references
- Tooling workflows
- Runtime workflows
- Existing content
- Existing games

---

# Editor Rule
The editor is a production tool.

Not a demo.

Not a convenience feature.

Not an optional extra.

Changes that impact editor workflows should be evaluated carefully.

Editor compatibility matters.

Export compatibility matters.

Authoring workflows matter.

---

# Tooling Rule
Tooling exists to increase development speed.

If a proposal:

- Slows authoring
- Complicates workflows
- Increases manual work

Then the proposal should be examined critically.

---

# Rendering Rule
The renderer intentionally embraces retro constraints.

Goals include:

- PS1-inspired aesthetics
- Software rendering
- Stylized presentation
- Predictable visuals
- Retro authenticity

Photorealism is not a goal.

Modern rendering trends are not automatically improvements.

---

# Performance Rule
Optimize based on evidence.

Not assumptions.

Use:

- Profiling
- Measurements
- Benchmarks

Before proposing performance-related changes.

---

# Modding Rule
The engine has strong modding influences.

Many design decisions prioritize:

- Content replacement
- Content reuse
- Data portability
- Asset portability

These are features.

Not limitations.

---

# Future-Proofing Rule
Do not remove flexibility simply because it is not currently used.

Some systems exist:

- For future projects
- For future genres
- For future content
- For future tooling

Unused today does not mean unnecessary tomorrow.

---

# Communication Rule
When uncertain:

Say so.

When assumptions are required:

Label them.

When evidence is missing:

Request evidence.

Do not present speculation as fact.

---

# Preferred Agent Behavior

1. Read first.
2. Verify assumptions.
3. Respect intent.
4. Preserve compatibility.
5. Stay within scope.
6. Use evidence.
7. Minimize disruption.
8. Enable development.
9. Preserve workflows.
10. Help ship games.

---

# Anti-Patterns To Avoid
Avoid:

- Unrequested rewrites
- Framework evangelism
- Architecture evangelism
- ECS evangelism
- Dependency-injection evangelism
- State-management evangelism
- File-splitting evangelism
- Trend-driven recommendations

No pattern is inherently superior.

Everything depends on context.

---

# Success Metric
The success metric is not:

"The architecture became cleaner."

The success metric is not:

"The code resembles another engine."

The success metric is:

"The developer can continue building games effectively."

---

# Final Rule
Read the files.

Trust the evidence.

Respect the human.

Preserve what works.

Solve the problem that was requested.

Help build games.
