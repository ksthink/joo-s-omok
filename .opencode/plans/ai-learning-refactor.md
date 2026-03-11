# AI 학습 성능 향상 + 대시보드 개선 리팩토링 계획

## 현재 시스템 한계점

1. **단방향 학습**: 플레이어 승리 시에만 학습 (AI 승리 무시)
2. **패턴 중복 카운팅**: evaluateLine에서 겹치는 패턴 전부 매치
3. **학습 적용 범위 좁음**: evaluateLine에서만 가중치 사용 (countThreats, move ordering 미반영)
4. **가중치 변화 제한적**: 0.5x~2.0x 범위, EMA 0.1 비율, 30게임 문턱
5. **맥락 무관 패턴**: 위치/게임단계 구분 없음
6. **코드 3중 중복**: BASE_WEIGHTS가 server.py, ai.js, dashboard/app.py에 각각 정의

## Phase 1: AI 엔진 핵심 수정 (ai.js)

### 1-1. evaluateLine 배타적 패턴 매칭
- 패턴을 길이/우선순위 순 정렬
- 매치된 위치 마킹하여 중복 매치 방지
- greedy non-overlapping 매칭

### 1-2. countThreats/scoreMoveForOrdering에 학습 가중치 반영
- 하드코딩된 상수를 getPatternWeight() 호출로 교체
- attack/defense 가중치 분리 적용

### 1-3. 증분 평가(Incremental Evaluation) 도입
- boardScore 글로벌 변수로 누적
- applyMove/undoMove에서 delta만 계산
- minimax에서 전체 보드 스캔 제거

### 1-4. TT 개선
- 깊이 기반 교체 정책 (기존보다 깊은 depth만 덮어씀)
- getAIMove 진입 시 TT 항상 초기화
- Zobrist 해시 64비트 확장 (two 32-bit XOR 합)

## Phase 2: 학습 시스템 확장 (server.py)

### 2-1. 양방향 학습 + attack/defense 분리
- 플레이어 승: 플레이어 패턴→방어 강화, AI 패턴→공격 약화
- AI 승: AI 패턴→공격 강화
- DB 컬럼 추가: attack_weight, defense_weight, attack_win_count, defense_win_count

### 2-2. 맥락 기반 패턴 (위치+단계)
- 3개 위치 영역: center/edge/mid
- 3개 게임 단계: opening/midgame/endgame
- 패턴 키: `_OOO_:center:midgame`

### 2-3. 복합 위협 패턴 추가
- double_open_three (쌍삼), four_three (사삼), double_four (쌍사)
- 교차점 4방향 위협 분석으로 복합 패턴 기록

### 2-4. 가중치 파라미터 조정 + DB 마이그레이션
- min: 0.5x→0.3x, max: 2.0x→3.0x
- EMA: 0.9/0.1→0.85/0.15
- 학습 문턱: 30→15
- weight_history 테이블, composite_pattern_stats 테이블 추가

## Phase 3: 클라이언트 학습 가중치 활용 강화 (ai.js)

- loadPatternWeights에서 attack/defense 분리 로드
- evaluateBoard: AI돌→attack, 플레이어돌→defense 가중치
- 게임 단계별 가중치 전환 (getGamePhase)

## Phase 4: 대시보드 개선 (dashboard/)

### 4-1. 새 API (dashboard/app.py)
- /api/weight-history: 가중치 시계열
- /api/composite-stats: 복합 위협 통계
- /api/learning-progress: 학습 진행률

### 4-2. 새 UI (templates/index.html)
- 학습 진행 프로그레스 바
- Attack/Defense 가중치 비교 테이블
- 가중치 변화 추이 시각화
- 복합 위협 통계 탭
- 게임 단계별 패턴 분석

### 4-3. 버그 수정 (script.js)
- XSS: innerHTML에 사용자 입력 이스케이프
- fetch .catch() 추가
- res.ok 검사

## Phase 5: 공유 코드 정리

### 5-1. weights_config.json 생성 (BASE_WEIGHTS 단일 소스)
### 5-2. board-renderer.js 공통 모듈 추출
### 5-3. 폰트 중복 제거 (dashboard/static/font.woff2 삭제)

## Phase 6: game.js 버그 수정

- 타이머 누수: surrender/새 게임 시 clearInterval 먼저 호출
- XSS: innerHTML에 playerName/entry.name 이스케이프
- 더블 이벤트: touchstart/click 중복 방지 개선

## 변경 파일 목록

| 파일 | 변경 |
|---|---|
| ai.js | 전면 리팩토링 |
| server.py | 양방향 학습, 맥락 패턴, DB 마이그레이션 |
| game.js | 버그 수정, XSS, 가중치 로드 개선 |
| dashboard/app.py | 새 API 엔드포인트 |
| dashboard/static/script.js | 학습 시각화, 에러 핸들링, XSS |
| dashboard/templates/index.html | 새 UI 요소 |
| dashboard/static/style.css | 새 스타일 |
| 신규: board-renderer.js | 공통 보드 렌더링 |
| 신규: weights_config.json | 단일 BASE_WEIGHTS |
