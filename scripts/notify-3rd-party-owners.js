const fs = require('node:fs')
const jsyaml = require('js-yaml')

const release_schedule = jsyaml.load(fs.readFileSync('release-schedule.yaml', 'utf8'))

// Returns the release that should be notified about right now:
//   - if INPUT_RHDH_VERSION is set (manual workflow_dispatch), look it up directly
//   - otherwise (scheduled run), find the release whose notification window
//     (13-19 days before feature freeze) includes today
// Returns null if nothing matches.
const getCurrentRelease = function(){
  const inputVersion = process.env.INPUT_RHDH_VERSION

  if (inputVersion){
    return release_schedule['releases'].find(r => r['rhdh-version'] === inputVersion) || null
  }

  for (const release of release_schedule['releases']){
    let ff_date = new Date(release['feature-freeze'])
    let notify_date = new Date(ff_date)
    notify_date.setDate(notify_date.getDate() - 13)

    let diffTime = notify_date - new Date()
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

    if (diffDays <= 6 && diffDays >= 0){
      return release
    }
  }
  return null
}

const getBackstageVersion = function(release){
  return release['backstage-version'].split('.').slice(0, 2).join('.')
}

const CODEOWNERS = String(fs.readFileSync('.github/CODEOWNERS'))

// Returns a Map<workspaceName, string[]> of every workspace that has an
// explicit CODEOWNERS entry. Per team decision, workspaces without a
// specific owner are left blank in CODEOWNERS, so an explicit entry
// here is an intentional opt-in to being notified, no need to distinguish external vs internal.
const getWorkspaceOwners = function(codeownersText){
  const ownersByWorkspace = new Map()

  for (const rawLine of codeownersText.split('\n')){
    const line = rawLine.trim()

    // skip blank lines and comments (includes disabled workspaces like "# /workspaces/acs")
    if (line === '' || line.startsWith('#')){
      continue
    }

    const match = line.match(/^(\/workspaces\/\S+)\s+(.+)$/)
    if (!match){
      continue
    }

    const workspacePath = match[1]
    const ownersBlob = match[2]

    const handles = ownersBlob.split(/\s+/).filter(h => h.startsWith('@'))
    if (handles.length === 0){
      continue
    }

    // normalize e.g. /workspaces/analytics/plugins/foo -> analytics
    const workspaceName = workspacePath.replace(/^\/workspaces\//, '').split('/')[0]

    const existing = ownersByWorkspace.get(workspaceName) || []
    ownersByWorkspace.set(workspaceName, [...new Set([...existing, ...handles])])
  }

  return ownersByWorkspace
}

const workspaceOwners = getWorkspaceOwners(CODEOWNERS)

// Returns true if `current` (major.minor) is strictly behind `target` (major.minor).
// Compares major and minor as separate integers rather than parsing the whole
// string as a float or number, since e.g. parseFloat("1.9") > parseFloat("1.10")
// even though 1.10 is the newer minor version.
const isVersionBehind = (current, target) => {
  const [currentMajor, currentMinor] = current.split('.').map(Number)
  const [targetMajor, targetMinor] = target.split('.').map(Number)

  return currentMajor < targetMajor || (currentMajor === targetMajor && currentMinor < targetMinor)
}

// Compares each explicitly-owned workspace's current Backstage version (from
// source.json) against targetBsVersion, and returns the ones that are behind.
const getWorkspacesBsVersion = (workspaceOwners, targetBsVersion) => {
  let ownersToNotify = []

  for (const [workspace, owners] of workspaceOwners){
    const sourcePath = `workspaces/${workspace}/source.json`
    if (!fs.existsSync(sourcePath)){
      console.log(`${workspace}: no source.json, skipping`)
      continue
    }

    const source = JSON.parse(fs.readFileSync(sourcePath))
    const currentVersion = source['repo-backstage-version']
    if (!currentVersion){
      console.log(`${workspace}: no repo-backstage-version in source.json, skipping`)
      continue
    }
    const workspaceBsVersion = currentVersion.split('.').slice(0, 2).join('.')

    if (isVersionBehind(workspaceBsVersion, targetBsVersion)){
      ownersToNotify.push({ workspace, owners, currentVersion, repo: source.repo })
    }
  }

  return ownersToNotify
}

// ── Issue creation ──────────────────────────────────────────────────

const NOTIFICATION_LABEL = 'update-notification'

async function ensureLabelExists(github, owner, repo){
  try {
    await github.rest.issues.getLabel({ owner, repo, name: NOTIFICATION_LABEL })
  } catch (error) {
    if (error.status !== 404){
      throw error
    }
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: NOTIFICATION_LABEL,
      color: '1d76db',
      description: 'Automated notification about Backstage version bumps',
    })
  }
}

function buildIssueBody(notification, release){
  const { workspace, currentVersion, repo, owners } = notification
  const ownerMentions = owners.join(', ')

  return [
    `## Backstage version bump — action needed`,
    ``,
    `**RHDH ${release['rhdh-version']}** is targeting **Backstage ${release['backstage-version']}**.`,
    `The \`${workspace}\` workspace is currently on Backstage **${currentVersion}**.`,
    ``,
    `### What you need to do`,
    ``,
    `1. Update your plugin in the upstream repository to be compatible with Backstage ${release['backstage-version']}`,
    `2. Once updated, the [daily update workflow](../../actions/workflows/update-plugins-repo-refs.yaml) will automatically create a PR in this repo to update the workspace reference`,
    `3. Alternatively, you can trigger the update workflow yourself. See https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Metadata-Synchronization#automated-synchronization for more:`,
    ``,
    `### Timeline`,
    ``,
    `| Milestone | Date |`,
    `|-----------|------|`,
    `| Feature freeze | ${release['feature-freeze']} |`,
    ``,
    `### Details`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Workspace | \`workspaces/${workspace}\` |`,
    `| Upstream repo | ${repo} |`,
    `| Current Backstage version | ${currentVersion} |`,
    `| Target Backstage version | ${release['backstage-version']} |`,
    ``,
    `### Resources`,
    ``,
    `- [Plugin owner responsibilities](../../blob/main/user-guide/03-plugin-owner-responsibilities.md)`,
    `- [Version updates guide](../../blob/main/user-guide/05-version-updates.md)`,
    ``,
    `---`,
    `cc ${ownerMentions}`,
  ].join('\n')
}

async function createNotificationIssues(github, context, notifications, release){
  const { owner, repo } = context.repo

  await ensureLabelExists(github, owner, repo)

  const existing = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    labels: NOTIFICATION_LABEL,
    state: 'open',
  })
  const existingTitles = new Set(existing.map(i => i.title))

  for (const notification of notifications){
    const title = `[RHDH ${release['rhdh-version']}] Backstage ${release['backstage-version']} compatibility: ${notification.workspace}`

    if (existingTitles.has(title)){
      console.log(`Issue already exists for ${notification.workspace}, skipping`)
      continue
    }

    const issue = await github.rest.issues.create({
      owner,
      repo,
      title,
      body: buildIssueBody(notification, release),
      labels: [NOTIFICATION_LABEL],
    })

    console.log(`Created issue #${issue.data.number} for ${notification.workspace}: ${issue.data.html_url}`)
  }
}

// ── Entry point (called by actions/github-script) ───────────────────

module.exports = async ({ github, context }) => {
  const release = getCurrentRelease()
  if (!release){
    console.log('No release needs notifying this week.')
    return
  }

  const targetBsVersion = getBackstageVersion(release)
  const notifications = getWorkspacesBsVersion(workspaceOwners, targetBsVersion)

  if (notifications.length === 0){
    console.log('All owned workspaces are up to date. No notifications needed.')
    return
  }

  console.log(`${notifications.length} workspace(s) need notification:`)
  for (const n of notifications){
    console.log(`  ${n.workspace}: ${n.currentVersion} -> ${release['backstage-version']} (${n.owners.join(', ')})`)
  }

  if (process.env.INPUT_DRY_RUN === 'true'){
    console.log('Dry run — no issues created.')
    return
  }

  await createNotificationIssues(github, context, notifications, release)
}
