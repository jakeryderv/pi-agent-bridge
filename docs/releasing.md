# Release process

Publishing is a separate, human-approved process. Passing CI is necessary but does not authorize a release.

## Prepare

1. Confirm the release scope and compatibility notes.
2. Update `CHANGELOG.md` and remove changes from `Unreleased` into a dated version section.
3. Update `package.json` version using the intended semantic-versioning level.
4. Verify official runtime compatibility notes and minimum Pi/Node versions.
5. Run:

   ```bash
   npm ci
   npm run check
   npm run security:audit
   npm run smoke:pi
   npm pack --dry-run
   ```

6. Install the packed tarball into a clean temporary Pi config and run a manual real-runtime smoke for each supported provider. Do not publish based only on fixture tests.
7. Review the tarball contents, dependency tree, and audit output.

## Publish

1. Merge the focused release pull request.
2. Create a signed `vX.Y.Z` tag from the reviewed commit.
3. Publish publicly with npm provenance from a trusted release environment:

   ```bash
   npm publish --access public --provenance
   ```

4. Create a GitHub release from the tag using the changelog section.

## Verify and observe

1. Confirm npm metadata and package contents.
2. Install with `pi install npm:@jakeryderv/pi-agent-bridge@X.Y.Z` in a clean environment.
3. Verify Pi loads both tools.
4. Run bounded real Codex and Claude tasks, cancellation, and session resume.
5. Watch installation, audit, and compatibility reports. Open follow-up issues for actionable findings.

If evidence invalidates an ADR or compatibility claim, update the documentation explicitly rather than silently diverging.
