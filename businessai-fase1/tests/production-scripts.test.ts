import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const migrateYml = read('../../.github/workflows/production-migrate.yml')
const inspectYml = read('../../.github/workflows/production-inspect.yml')
const backupYml = read('../../.github/workflows/production-backup-proof.yml')
const lib = read('../scripts/production/lib.sh')
const bash = (script: string) => execFileSync('bash', ['-c', `source scripts/production/lib.sh; ${script}`], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }).trim()

describe('Production procedure (scripts/production)', () => {
  it('pins the Production project in code and refuses Staging or any other project', () => {
    expect(lib).toContain('PRODUCTION_REF=rugqcumiuqrjbfwpuslm')
    const g = (u: string) => bash(`strict_production_url '${u}' >/dev/null && echo accept || echo refuse`)
    expect(g('postgresql://postgres.rugqcumiuqrjbfwpuslm:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres')).toBe('accept')
    expect(g('postgresql://postgres:x@db.rugqcumiuqrjbfwpuslm.supabase.co:5432/postgres')).toBe('accept')
    expect(g('postgresql://postgres.wbfpvxptoujgvflljasc:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres')).toBe('refuse')
    expect(g('postgresql://postgres.other:x@host/db?ref=rugqcumiuqrjbfwpuslm')).toBe('refuse')
  })
  it('the order is the Staging ORDER from 0005: 39 migrations, phase 1 = the first five', () => {
    const order = bash('prod_order').split('\n')
    expect(order).toHaveLength(39)
    expect(order.slice(0, 5).join(' ')).toBe(bash('echo $PHASE1'))
    expect(order.at(-1)).toBe('0045_platform_stabilization')
  })
  it('the next migration is the first not applied; anything else stops', () => {
    const rows = (applied: number, extra = '') => bash(`{ echo '0001–0004 base schema|applied'; i=0; for m in $(prod_order); do i=$((i+1)); [ $i -le ${applied} ] && s=applied || s='not applied'; echo "$m|$s"; done; echo 'staging bookkeeping (ba_meta)|absent'; ${extra} } | next_migration || true`)
    expect(rows(0)).toBe('0005_security_baseline')
    expect(rows(5)).toBe('0010_billing')
    expect(rows(39)).toBe('none')
    expect(rows(3, "echo '0011_usage_limits|applied';")).toMatch(/^STOP/)
    expect(rows(3, "echo '0010_billing|PARTIAL — review';")).toMatch(/^STOP/)
    expect(bash(`{ echo '0001–0004 base schema|applied'; echo 'staging bookkeeping (ba_meta)|present (staging?)'; } | next_migration || true`)).toMatch(/^STOP/)
  })
  it('every Production run waits for the owner in the protected Environment, one migration per label', () => {
    for (const yml of [migrateYml, inspectYml, backupYml]) {
      expect(yml).toContain('environment: production')
      expect(yml).toContain('environments/production')
      expect(yml).toContain('select(.type == "required_reviewers")')
      expect(yml).toContain('needs: protection')
      expect(yml).not.toMatch(/workflow_dispatch|push:|schedule:/)
      const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
      expect(code).not.toMatch(/STRIPE|VERCEL_TOKEN|vercel/i)
    }
    expect(migrateYml).toContain("startsWith(github.event.label.name, 'production:migrate:')")
    expect(migrateYml).toMatch(/Backup BEFORE[\s\S]*Apply ONLY the requested migration[\s\S]*Backup AFTER/)
    expect(migrateYml).toMatch(/Plan \(read-only\)[\s\S]*Backup BEFORE/)
    expect(inspectYml).toContain("github.event.label.name == 'production:inspect'")
    expect(backupYml).toContain("github.event.label.name == 'production:backup-proof'")
  })
  it('Production secrets exist only as Environment secrets, read only by the approved Production jobs', () => {
    // Policy: PRODUCTION_DB_URL and PRODUCTION_BACKUP_PASSPHRASE are Environment secrets of "production" (required
    // reviewer). A repository-level copy or fallback (e.g. *_CI) is forbidden: GitHub cannot restrict a repository
    // secret to one workflow, branch or job, so any workflow on any branch of the repository could read it.
    // YAML is parsed with js-yaml, already installed in the project (dependency of eslint → @eslint/eslintrc)
    const yaml = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown }
    type Job = { environment?: unknown; needs?: unknown; steps?: unknown[]; [k: string]: unknown }
    type Workflow = { on?: unknown; true?: unknown; jobs?: Record<string, Job> }
    const dir = new URL('../../.github/workflows/', import.meta.url).pathname
    const files = execFileSync('ls', [dir], { encoding: 'utf8' }).trim().split('\n').filter((f) => /\.ya?ml$/.test(f))
    // the three Production workflows and the one job in each that may read the Production secrets
    const production: Record<string, string> = { 'production-backup-proof.yml': 'backup', 'production-inspect.yml': 'inspect', 'production-migrate.yml': 'migrate' }
    const prodSecret = /secrets\.(PRODUCTION_[A-Z_]+)/g
    for (const f of Object.keys(production)) expect(files, f).toContain(f)
    for (const f of files) {
      const raw = read(`../../.github/workflows/${f}`)
      const wf = yaml.load(raw) as Workflow
      const triggers = Object.keys((wf.on ?? wf.true ?? {}) as object)
      const jobs = Object.entries(wf.jobs ?? {})
      // no privileged PR trigger, no reusable workflow, no forwarding of every secret
      expect(triggers, f).not.toContain('pull_request_target')
      expect(triggers, f).not.toContain('workflow_call')
      expect(raw, f).not.toMatch(/secrets:\s*inherit|toJSON\(secrets\)/)
      for (const [id, job] of jobs) {
        const body = JSON.stringify(job)
        expect(typeof job.uses === 'string' && job.uses.startsWith('./'), `${f}:${id} calls a local reusable workflow`).toBe(false)
        const names = [...body.matchAll(prodSecret)].map((m) => m[1])
        // no repository-level fallback (e.g. PRODUCTION_DB_URL_CI): only the two Environment secrets exist
        for (const n of names) expect(['PRODUCTION_DB_URL', 'PRODUCTION_BACKUP_PASSPHRASE'], `${f}:${id}`).toContain(n)
        if (!names.length) continue
        // a job that reads them is exactly the authorised Production job, bound to the protected Environment and
        // started only after the protection job
        expect(production[f], `${f}:${id} reads Production secrets but is not an authorised Production job`).toBe(id)
        expect(job.environment, `${f}:${id}`).toBe('production')
        expect(job.needs, `${f}:${id}`).toBe('protection')
        // never printed or exported (values only reach the scripts through step env)
        for (const s of (job.steps ?? []) as { run?: string }[]) {
          expect(s.run ?? '', `${f}:${id}`).not.toMatch(/echo[^\n]*\$\{?(PRODUCTION_DB_URL|BACKUP_PASSPHRASE)\b|(PRODUCTION_DB_URL|BACKUP_PASSPHRASE)[^\n]*(GITHUB_ENV|GITHUB_OUTPUT)/)
        }
      }
      if (!(f in production)) continue
      // each Production workflow: the authorised job exists with environment: production + needs: protection, and the
      // protection job (no Environment, runs before the approval) never sees a Production secret
      const job = wf.jobs?.[production[f]]
      expect(job, `${f}: job ${production[f]}`).toBeDefined()
      expect(job?.environment, `${f}:${production[f]}`).toBe('production')
      expect(job?.needs, `${f}:${production[f]}`).toBe('protection')
      expect(JSON.stringify(job), `${f}:${production[f]}`).toMatch(/secrets\.PRODUCTION_DB_URL/)
      const protection = wf.jobs?.protection
      expect(protection, `${f}: protection job`).toBeDefined()
      expect(protection?.environment, `${f}:protection`).toBeUndefined()
      expect(JSON.stringify(protection), `${f}:protection`).not.toMatch(/PRODUCTION_DB_URL|PRODUCTION_BACKUP_PASSPHRASE/)
    }
  })
  it('the reinspection is read-only only; the backup proof is separate and needs real binaries', () => {
    const code = (y: string) => y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code(inspectYml)).not.toMatch(/backup\.sh|pg_dump|pg_restore|initdb|migrate\.sh/)
    expect(code(backupYml)).toContain('bash scripts/production/backup.sh')
    expect(code(backupYml)).not.toMatch(/migrate\.sh|inspect\.sh/)
    for (const yml of [backupYml, migrateYml]) expect(yml).toContain('[ -x "$PGB/initdb" ]')
    expect(inspectYml).not.toContain('toJSON(secrets)')
    // the reinspection stores nothing: no artifact, no output file, no encryption key
    expect(code(inspectYml)).not.toMatch(/upload-artifact|BACKUP_PASSPHRASE|OUT_DIR/)
    const inspectSh = read('../scripts/production/inspect.sh')
    expect(inspectSh).not.toMatch(/OUT_DIR|openssl|tar -|> *"\$|>> *"\$/)
    // PASS/FAIL and BLOCKER lines only: no measured value, no company / subscription / plan counts in the log
    expect(inspectSh).not.toMatch(/got '|by_status|by_plan|echo "    \$c: /)
    expect(inspectSh).toContain('ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3"; fi; }')
  })
  it('only encrypted files leave the runner', () => {
    for (const yml of [migrateYml, backupYml]) {
      const paths = [...yml.matchAll(/path: (.+)/g)].map((m) => m[1])
      expect(paths.length).toBeGreaterThan(0)
      for (const p of paths) expect(p).toMatch(/\*\.enc$/)
    }
    const backup = read('../scripts/production/backup.sh')
    expect(backup).toContain('a Production backup is never kept unencrypted')
    expect(backup).toContain('a Production backup always gets a restore test')
    expect(backup).toContain('rm -rf "$work" "$bundle"')
  })
  it('phase 2 needs the owner decision; inspection is read-only', () => {
    const migrate = read('../scripts/production/migrate.sh')
    expect(migrate).toContain('PHASE2_DECISION')
    expect(migrate).toMatch(/is_phase1 "\$TARGET"/)
    const inspect = read('../scripts/production/inspect.sh')
    expect(inspect).toContain("default_transaction_read_only=on")
    expect(inspect).not.toMatch(/psql "\$PRODUCTION_DB_URL" -X -q -v ON_ERROR_STOP=1 -f/)
  })
})
