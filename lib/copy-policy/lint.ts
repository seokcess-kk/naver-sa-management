/**
 * 소재 / 광고 카피 사전 lint (Phase F.1).
 *
 * 책임:
 *   - 소재 텍스트(제목/설명/랜딩 URL/비즈채널 정보)를 등록 전 정규식 룰로 검사
 *   - 출력: LintIssue[] — UI 가 사용자에게 표시 + severity 'error' 는 등록 차단
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - 정규식 기반 "사례·추정" 룰 — 절대 차단은 'error', 경고는 'warn'
 *   - 의료/금융/건강기능식품/주류 등 업종별 추가 룰은 industry 인자로 분기
 *   - LLM 무관 — 외부 호출 0
 *
 * 비대상:
 *   - 검수 반려 사후 분류 (lib/copy-policy/classify-rejection.ts — 후속 PR)
 *   - 수정안 자동 생성 (LLM — Phase F 활성화 후)
 *
 * 룰 출처:
 *   - 네이버 검색광고 광고 가이드 (객관 자료 없는 최상급 표현 제한)
 *   - 운영 일반론 (i-boss / brunch / openads 사례)
 */

// =============================================================================
// 타입
// =============================================================================

export type LintIndustry = "general" | "medical" | "finance" | "health_food"

export type LintSeverity = "error" | "warn"

export type LintIssue = {
  /** 어떤 룰이 매치됐는지. */
  ruleId: string
  /** 매치된 텍스트 부분 (UI 하이라이트용). */
  match: string
  /** 사용자에게 표시할 한글 사유. */
  message: string
  severity: LintSeverity
  /** 룰 룰 (regex source). 디버깅·설명. */
  pattern?: string
}

// =============================================================================
// 룰 정의
// =============================================================================

type Rule = {
  ruleId: string
  message: string
  severity: LintSeverity
  /** 단어 경계 / 부분 매치는 정규식에 직접 명시. 'gi' 플래그 권장. */
  regex: RegExp
  /** 적용 industry. undefined = 모든 industry. */
  industries?: LintIndustry[]
}

/**
 * 공통 — 객관 자료 없는 최상급 / 검증불가 표현.
 *
 * 네이버 검색광고 광고 가이드는 다음 표현을 제한:
 *   "최고", "1위", "1순위", "최초", "최상", "무조건", "국내 유일", "보장",
 *   "100%", "단연", "유일한", "최다" 등.
 *
 * 운영 시 객관 자료(공인 평가·시상 출처) 명시 시 일부 허용 가능 — 단 자동 lint 는
 * 보수적으로 차단(error), 운영자가 출처 확보 후 명시적으로 우회 (UI override 후속).
 */
const RULES_GENERAL: Rule[] = [
  {
    ruleId: "superlative_top",
    message:
      "객관 자료 없는 최상급 표현은 광고 가이드 위반 가능. (최고 / 1위 / 최초 / 최상 / 단연)",
    severity: "error",
    regex: /(최고|1\s*위|1\s*순위|최초|최상|단연|유일한|최다)/g,
  },
  {
    ruleId: "superlative_unique",
    message: "검증 불가 '국내 유일 / 세계 최초' 등 표현은 가이드 위반 가능.",
    severity: "error",
    regex: /(국내\s*유일|세계\s*최초|업계\s*최초|국내\s*최초)/g,
  },
  {
    ruleId: "guarantee_absolute",
    message: "보장 / 무조건 / 100% 같은 절대 표현은 가이드 위반 가능.",
    severity: "error",
    regex: /(보\s*장|무조건|100\s*%)/g,
  },
  {
    ruleId: "fastest_cheapest",
    message: "최저가 / 최저 / 가장 빠른 등 비교 최상급은 객관 자료 없으면 차단.",
    severity: "error",
    regex: /(최저가|최저|가장\s*빠른|가장\s*저렴)/g,
  },
  {
    ruleId: "competitor_brand",
    message:
      "타사 브랜드명 직접 언급은 상표권 침해 위험 — 검수 반려 가능.",
    severity: "warn",
    // 운영 시 광고주별 화이트리스트 추가 검토 — 본 PR 은 기본 검출만
    regex: /(쿠팡|네이버|카카오|11번가|G마켓|옥션|위메프|티몬)/g,
  },
]

/** 의료 — 효과·치료·완치 등 표현 */
const RULES_MEDICAL: Rule[] = [
  {
    ruleId: "medical_effect_claim",
    message:
      "의료 광고 — 효과·치료·완치·즉시 효과 등 표현은 의료법 광고 제한 위반 가능.",
    severity: "error",
    regex: /(완치|즉시\s*효과|치료\s*효과|당일\s*완치|반드시\s*나음)/g,
    industries: ["medical"],
  },
  {
    ruleId: "medical_before_after",
    message: "치료 전·후 비교 표현은 의료법 광고 위반 가능.",
    severity: "warn",
    regex: /(치료\s*전후|시술\s*전후|수술\s*전후)/g,
    industries: ["medical"],
  },
]

/** 금융 — 무위험·확정 수익 등 표현 */
const RULES_FINANCE: Rule[] = [
  {
    ruleId: "finance_no_risk",
    message:
      "금융 광고 — 무위험·확정 수익·원금 보장 등 표현은 금융 광고 가이드 위반.",
    severity: "error",
    regex: /(무위험|확정\s*수익|원금\s*보장|손실\s*없음|무조건\s*수익)/g,
    industries: ["finance"],
  },
  {
    ruleId: "finance_high_return",
    message: "구체 수익률 명시는 금융감독원 광고 가이드 위반 가능 (출처·기간 필수).",
    severity: "warn",
    regex: /(\d+\s*%\s*수익|연\s*\d+\s*%)/g,
    industries: ["finance"],
  },
]

/** 건강기능식품 — 효능·치료 표현 */
const RULES_HEALTH_FOOD: Rule[] = [
  {
    ruleId: "health_food_treatment",
    message:
      "건강기능식품 — 질병 치료·예방 표현은 식품법 광고 제한 위반 가능.",
    severity: "error",
    regex: /(예방|치료|개선|완화)/g,
    industries: ["health_food"],
  },
  {
    ruleId: "health_food_medical_claim",
    message: "건강기능식품 — 의약품 같은 표현 ('약 효과', '병 낫는') 차단.",
    severity: "error",
    regex: /(약\s*효과|병\s*낫|병\s*나음|수술\s*대신|약\s*대신)/g,
    industries: ["health_food"],
  },
]

const ALL_RULES: Rule[] = [
  ...RULES_GENERAL,
  ...RULES_MEDICAL,
  ...RULES_FINANCE,
  ...RULES_HEALTH_FOOD,
]

// =============================================================================
// 핵심 함수
// =============================================================================

/**
 * 텍스트 1건 lint.
 *
 * @param text     검사 대상 (제목/설명/랜딩 URL 등 호출자가 결합 또는 분리 호출)
 * @param industry 광고주 업종. 미지정 시 'general' 룰만 적용
 */
export function lintCopyText(
  text: string,
  industry: LintIndustry = "general",
): LintIssue[] {
  if (!text || text.length === 0) return []

  const issues: LintIssue[] = []
  const applicableRules = ALL_RULES.filter(
    (r) => !r.industries || r.industries.includes(industry),
  )

  for (const rule of applicableRules) {
    // regex.lastIndex 갱신 안전 — 매 호출마다 새 RegExp 또는 reset
    rule.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.regex.exec(text)) !== null) {
      issues.push({
        ruleId: rule.ruleId,
        match: m[0],
        message: rule.message,
        severity: rule.severity,
        pattern: rule.regex.source,
      })
      // 무한 루프 방지 (zero-width match)
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++
    }
  }

  return issues
}

/**
 * 다중 텍스트 일괄 lint (예: 제목 + 설명).
 *
 * 같은 룰이 여러 텍스트에 매치되면 각각 별도 issue.
 */
export function lintCopyFields(
  fields: Record<string, string>,
  industry: LintIndustry = "general",
): Array<LintIssue & { field: string }> {
  const all: Array<LintIssue & { field: string }> = []
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue
    const issues = lintCopyText(text, industry)
    for (const i of issues) {
      all.push({ ...i, field })
    }
  }
  return all
}

/** error 1건 이상이면 등록 차단 권장. */
export function hasBlockingIssues(issues: LintIssue[]): boolean {
  return issues.some((i) => i.severity === "error")
}
