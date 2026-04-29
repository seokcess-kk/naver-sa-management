/**
 * 정적 시크릿 누설 가드 (CI 회귀 방지)
 *
 * 목적: 소스 코드에 평문 시크릿이 console / JSON / Sentry / throw 메시지로
 *       흘러갈 수 있는 위험 패턴이 들어왔을 때 CI 단계에서 차단.
 *
 * 동작: app/, lib/, components/, scripts/ 하위 .ts/.tsx 를 직접 읽어
 *       위험 정규식 패턴별로 매칭 0건을 단언.
 *
 * 화이트리스트: 본 가드의 의도된 예외 — 시크릿 핸들링 자체가 책임인 파일.
 *   - lib/crypto/secret.ts (encrypt/decrypt/mask 정의 자체)
 *   - lib/naver-sa/credentials.ts (decrypt → 평문 키 메모리 핸들링)
 *   - lib/naver-sa/client.ts (HMAC 서명 시 secretKey 사용 — 외부 노출 X)
 *   - lib/audit/sanitize.ts (마스킹 키 정의 자체)
 *   - *.test.ts / tests/**
 *
 * 한계 (본 PR 범위 외):
 *   - Sentry beforeSend 스크러빙은 Sentry 설정 파일 도입 후 추가 예정
 *   - 런타임 누설(런타임 console.log(creds))은 단위/E2E 테스트로 별도 검증
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "..")

const SCAN_DIRS = ["app", "lib", "components", "scripts"]

const EXCLUDE_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  "dist",
  "generated", // Prisma 생성물 (lib/generated)
])

/** 화이트리스트: 의도된 시크릿 핸들링 파일 — 정확 매치(repo root 기준 슬래시 경로). */
const WHITELIST_RELATIVE = new Set<string>([
  "lib/crypto/secret.ts",
  "lib/naver-sa/credentials.ts",
  "lib/naver-sa/client.ts",
  "lib/audit/sanitize.ts",
])

type Pattern = {
  label: string
  regex: RegExp
}

/**
 * 위험 패턴 (true positive 우선, false positive 최소).
 *
 * 1. console.* 안에 secretKey/apiKey 변수 직접 들어감
 * 2. console.* 안에 creds.secretKey / creds.apiKey 접근
 * 3. JSON.stringify(creds, ...)
 * 4. JSON.stringify 인자에 secretKey/apiKey 변수
 * 5. throw new Error 의 템플릿 리터럴에 시크릿 보간
 * 6. Sentry.captureException 안에 creds
 * 7. throw new Error 안 시크릿 concat (`+` 연산자)
 * 8. console.* 안에 Authorization 헤더 노출
 * 9. console.* 안에 CRON_SECRET 평문 노출
 */
const PATTERNS: Pattern[] = [
  {
    label: "console.* 인자에 secretKey/apiKey 변수",
    regex: /console\.(?:log|error|warn|info|debug)\([^)]*\b(?:secretKey|apiKey)\b/,
  },
  {
    label: "console.* 인자에 creds.secretKey/apiKey 접근",
    regex: /console\.(?:log|error|warn|info|debug)\([^)]*\bcreds\.(?:secretKey|apiKey)\b/,
  },
  {
    label: "JSON.stringify(creds, ...)",
    regex: /JSON\.stringify\(\s*creds\b/,
  },
  {
    label: "JSON.stringify 인자에 secretKey/apiKey 변수",
    regex: /JSON\.stringify\([^)]*\b(?:secretKey|apiKey)\b/,
  },
  {
    label: "throw new Error 템플릿 리터럴에 시크릿 보간",
    regex: /throw new Error\([^)]*\$\{[^}]*\b(?:secretKey|apiKey|creds\.)/,
  },
  {
    label: "Sentry.captureException 인자에 creds",
    regex: /Sentry\.captureException\([^)]*\bcreds\b/,
  },
  {
    // throw new Error("msg " + secretKey) / throw new Error("msg " + creds.apiKey)
    // `+` concat 으로 시크릿 보간되는 경우. 일반 e.message 는 매치 X.
    label: "throw new Error 안 concat 으로 시크릿 보간",
    regex: /throw new Error\([^)]*\+\s*[^)]*\b(?:secretKey|apiKey|creds\.(?:secret|api)Key)\b/,
  },
  {
    // console.log("auth:", req.headers.authorization)
    // console.error(req.headers.get("Authorization"))
    // 화이트리스트 외 코드에서 console 에 Authorization 보간하는 경우만 차단
    label: "console.* 인자에 Authorization 헤더 노출",
    regex: /console\.(?:log|error|warn|info|debug)\([^)]*\b[Aa]uthorization\b/,
  },
  {
    // console.log("secret:", process.env.CRON_SECRET) 등
    // cron route 의 비교문(if (auth !== `Bearer ${cronSecret}`)) 은 console 에 안 들어가니 매치 X
    label: "console.* 인자에 CRON_SECRET 평문 노출",
    regex: /console\.(?:log|error|warn|info|debug)\([^)]*\bCRON_SECRET\b/,
  },
]

function relFromRepo(absPath: string): string {
  return absPath
    .substring(REPO_ROOT.length + 1)
    .split("\\")
    .join("/")
}

function listSourceFiles(rootAbs: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(rootAbs)
  } catch {
    return out
  }
  for (const name of entries) {
    if (EXCLUDE_DIR_NAMES.has(name)) continue
    const abs = join(rootAbs, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      listSourceFiles(abs, out)
    } else if (st.isFile()) {
      // .ts / .tsx 만, 단 .test.ts / .test.tsx / .d.ts 제외
      if (!/\.tsx?$/.test(name)) continue
      if (/\.test\.tsx?$/.test(name)) continue
      if (/\.d\.ts$/.test(name)) continue
      out.push(abs)
    }
  }
  return out
}

function isWhitelisted(absPath: string): boolean {
  const rel = relFromRepo(absPath)
  return WHITELIST_RELATIVE.has(rel)
}

function gatherTargetFiles(): string[] {
  const acc: string[] = []
  for (const dir of SCAN_DIRS) {
    listSourceFiles(join(REPO_ROOT, dir), acc)
  }
  return acc.filter((p) => !isWhitelisted(p))
}

describe("secret-leak-static", () => {
  const files = gatherTargetFiles()

  it("스캔 대상 파일이 1개 이상 존재", () => {
    // 디렉터리 구조 변경 감지 — 0개면 가드가 무력화된 것
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(PATTERNS.map((p) => [p.label, p.regex] as const))(
    "패턴 매치 0건: %s",
    (_label, regex) => {
      const matches: { file: string; line: number; text: string }[] = []
      for (const file of files) {
        let content: string
        try {
          content = readFileSync(file, "utf8")
        } catch {
          continue
        }
        const lines = content.split("\n")
        lines.forEach((text, i) => {
          if (regex.test(text)) {
            matches.push({ file: relFromRepo(file), line: i + 1, text: text.trim() })
          }
        })
      }
      const detail = matches
        .map((m) => `  ${m.file}:${m.line}  ${m.text}`)
        .join("\n")
      expect(matches, `시크릿 누설 패턴 매치 발견:\n${detail}`).toEqual([])
    },
  )
})

/**
 * 패턴 정밀도 회귀 가드.
 * 향후 누군가 정규식을 잘못 수정하면(예: word-boundary 누락, 알파벳 빠뜨림)
 * 본 fixture 단언이 실패해서 잡아냄.
 *
 * BAD_LINES: 신규 패턴 7~9 가 잡아야 하는 위험 라인
 * GOOD_LINES: 잡으면 false positive 가 되는 무해 라인
 */
describe("secret-leak-static — 패턴 정밀도 (fixture)", () => {
  const PATTERN_BY_INDEX: Record<number, RegExp> = {
    7: PATTERNS[6].regex, // throw new Error 안 concat 시크릿
    8: PATTERNS[7].regex, // console.* Authorization
    9: PATTERNS[8].regex, // console.* CRON_SECRET
  }

  const BAD_LINES: { pattern: number; line: string }[] = [
    { pattern: 7, line: 'throw new Error("oops " + creds.secretKey)' },
    { pattern: 7, line: 'throw new Error("auth: " + apiKey)' },
    { pattern: 7, line: 'throw new Error("dump: " + creds.apiKey)' },
    { pattern: 8, line: 'console.log("auth:", req.headers.authorization)' },
    { pattern: 8, line: 'console.error(req.headers.get("Authorization"))' },
    { pattern: 9, line: 'console.warn("secret:", process.env.CRON_SECRET)' },
  ]

  const GOOD_LINES: { pattern: number; line: string }[] = [
    // 패턴 7 — 일반 에러 보간(시크릿 단어 없음)
    { pattern: 7, line: 'throw new Error("invalid input: " + e.message)' },
    { pattern: 7, line: 'throw new Error("not found: " + id)' },
    // 패턴 8 — Authorization 단어 안 들어감
    { pattern: 8, line: 'console.log("user-id:", userId)' },
    { pattern: 8, line: 'const auth = req.headers.get("authorization")' }, // console 아님
    // 패턴 9 — console 안에 CRON_SECRET 안 들어감
    { pattern: 9, line: 'if (auth !== `Bearer ${cronSecret}`) return 401' },
    { pattern: 9, line: 'const cron = process.env.CRON_SECRET' }, // console 아님
  ]

  it.each(BAD_LINES)("패턴 $pattern: 위험 라인 매치 — $line", ({ pattern, line }) => {
    const re = PATTERN_BY_INDEX[pattern]
    expect(re.test(line), `패턴 ${pattern} 가 위험 라인을 잡지 못함: ${line}`).toBe(true)
  })

  it.each(GOOD_LINES)("패턴 $pattern: 무해 라인 미매치 — $line", ({ pattern, line }) => {
    const re = PATTERN_BY_INDEX[pattern]
    expect(re.test(line), `패턴 ${pattern} 가 무해 라인을 잘못 잡음: ${line}`).toBe(false)
  })
})
