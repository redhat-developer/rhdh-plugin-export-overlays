# Detect Modified Workspaces

Composite action that detects which workspaces were modified in a pull request.

## Description

This action queries the GitHub API to get the list of files changed in a PR and extracts unique workspace names from paths matching `workspaces/<workspace-name>/...`.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `pr-number` | Yes | - | Pull request number |
| `token` | No | `${{ github.token }}` | GitHub token for API access |

## Outputs

| Output | Description | Example |
|--------|-------------|---------|
| `workspaces` | Newline-separated list of modified workspace names | `"tech-radar\ntopology"` |
| `workspace-count` | Number of modified workspaces | `"2"` |
| `single-workspace` | The single workspace name if count=1, empty otherwise | `"tech-radar"` or `""` |

## Usage

### Basic Usage

```yaml
- name: Detect modified workspaces
  id: detect
  uses: ./.github/actions/detect-modified-workspaces
  with:
    pr-number: ${{ github.event.pull_request.number }}

- name: Use outputs
  run: |
    echo "Modified workspaces: ${{ steps.detect.outputs.workspaces }}"
    echo "Count: ${{ steps.detect.outputs.workspace-count }}"
    if [[ -n "${{ steps.detect.outputs.single-workspace }}" ]]; then
      echo "Single workspace detected: ${{ steps.detect.outputs.single-workspace }}"
    fi
```

### Matrix Strategy

```yaml
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      workspaces: ${{ steps.detect.outputs.workspaces }}
    steps:
      - uses: actions/checkout@v6
      - id: detect
        uses: ./.github/actions/detect-modified-workspaces
        with:
          pr-number: ${{ inputs.pr-number }}

  process:
    needs: detect
    strategy:
      matrix:
        workspace: ${{ fromJson(format('["{0}"]', needs.detect.outputs.workspaces)) }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "Processing ${{ matrix.workspace }}"
```

### Conditional Execution

```yaml
- uses: ./.github/actions/detect-modified-workspaces
  id: detect
  with:
    pr-number: ${{ inputs.pr-number }}

- name: Run only if single workspace
  if: steps.detect.outputs.workspace-count == '1'
  run: |
    echo "Publishing ${{ steps.detect.outputs.single-workspace }}"
```

## Implementation Details

- Uses `pulls.listFiles` GitHub API endpoint
- Paginates through all changed files (100 per page)
- Extracts workspace names via regex: `/^workspaces\/([^\/]+)\/.*/`
- Returns unique workspace names (deduplicated)
- Writes summary to job summary for visibility

## Notes

- Requires `actions/checkout` to be run first (to make action available)
- API call counts against rate limits (typically not an issue)
- More reliable than `git diff` as it doesn't require fetching branches
- Consistent with existing workspace detection in auto-publish workflow
