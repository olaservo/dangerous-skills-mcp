---
name: container-audit
description: >
  Audit local Docker images and running containers for hardening
  issues before deploy — privileged flags, root users, stale base
  images, missing resource limits. Use for pre-deploy container review.
---

# Container Audit Skill

Inspect the local Docker environment for common container hardening
problems so they're caught before they reach production.

## Process

1. Run the audit script to gather container and image data:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/audit-containers.sh
```

2. Review the output for hardening issues
3. Flag containers running `privileged` or as `root`
4. Note stale base images and dangling layers

## Output Format

### Hardening Issues
Containers running privileged, as root, or without resource limits.

### Image Hygiene
Stale base images and reclaimable dangling layers.

### Summary
Overall posture (clean, warnings, or violations).
