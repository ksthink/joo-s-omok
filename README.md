# 주군의 한수

오목 AI와 대결하는 레트로 스타일의 웹 게임입니다. AI가 플레이어의 기보를 학습하여 점점 강해집니다.

## 소개

현재 버전: **v3.1.0** (첫 화면 하단에 표시, `game.js`의 `APP_VERSION`)

| 버전 | 변경 내용 |
|---|---|
| v3.2.0 | 챌린지 모드도 Rapfi로 대국(10단계, 단계별 탐색 깊이·시간·실수 확률 조정). 연습·챌린지 시작 시 흑/백 선택(백이면 AI가 먼저). 연습 모드 상태 칸은 글자 없이 흑·백 차례 불빛 + 수 번호 + AI·Jev 불빛, 챌린지는 기존 글자 상태에 AI·Jev 불빛만 추가 |
| v3.1.0 | 상태 칸은 차례만 표시, Rapfi·Jev 작동은 작은 점 두 개로 표시(작동 중 점등, Jev 실패 시 빨강) |
| v3.0.1 | Rapfi에 돌을 번갈아 두는 수순으로 전달(차례를 반대로 인식해 승률·수가 틀리던 문제 수정) |
| v3.0.0 | 연습 모드 엔진을 Rapfi(WebAssembly, NNUE)로 교체: Rapfi 상위 후보 중 Jev가 선택, 승률 막대는 Rapfi 평가. 로딩 전·실패 시 기본 MiniMax |
| v2.5.2 | "예상 수순" 토글 제거 |
| v2.5.1 | Jev 후보 고리는 AI가 생각하는 동안만 표시(확률 0.45초 노출 후 착수와 함께 제거) |
| v2.5.0 | 연습 모드 "예상 수순" 토글: AI 착수 뒤 엔진이 예상하는 이후 수순을 번호 붙은 사각형으로 표시(트랜스포지션 테이블에서 추출, 추가 탐색 없음) |
| v2.4.0 | 유령 돌을 점선 고리(청록, 돌과 구분)로 변경, 연습 모드 상단에 흑·백 승리 가능성(소수점 1자리; Jev 판단 또는 엔진 추정) |
| v2.3.0 | Jev 판단을 오버레이 대신 오목판 위 유령 돌로 표시(후보별 확률 %, 엔진 1순위 파란 테두리, 제외 후보 빨간 점선) + 상태 줄 요약 |
| v2.2.0 | 연습 모드 게임 화면 상단에 Jev 판단 오버레이(후보별 확률, 엔진 1순위와 실제 착수, 강제수·실패 상태) |
| v2.1.0 | 연습 모드에 Jev 직관 레이어(조용한 국면에서 MiniMax 후보 + Jev 확률 블렌딩, 실패 시 MiniMax 폴백) |
| v2.0.0 | AI 전술 계층(띈 4·띈 3 인식, 모든 노드 위협 기반 후보 제한), 차례를 아는 말단 평가, 평가 캐시로 탐색 깊이 약 2배 |
| v1.x | 최초 공개: MiniMax + 학습 가중치, 연습·챌린지·랭크 모드 |

"주군의 한수"는 인공지능과 대결하는 오목 게임입니다. 연습 모드에서 실력을 키우고, 챌린지 모드에서 10단계의 AI를 상대로 점수를 기록하세요. AI는 매 게임 후 학습하여 시간이 지날수록 더 강해집니다.

## 기능

### 게임 모드
- **연습 모드**: 자유롭게 AI와 대결하며 실력 향상
- **챌린지 모드**: 10단계 난이도 도전(Rapfi 엔진, 단계별 강도 조정), 점수 기록
- 두 모드 모두 시작할 때 흑(먼저 둠) 또는 백(AI가 먼저)을 고릅니다. 마지막 선택은 브라우저에 기억됩니다.
- **랭킹**: 상위 10명 기록 확인

### AI 특징
- **MiniMax + Alpha-Beta**: 최적의 수 탐색
- **양방향 학습**: 공격(Attack)과 방어(Defense) 가중치 분리 학습
- **1차원 패턴 학습**: 선형 패턴(열린3, 열린4 등) 학습
- **2차원 군집 패턴 학습**: ㅗ, +, X, L자, T자 등 군집 형태 학습
- **영향력 맵 기반 연결 학습**: 군집 간 연결 가능성 평가
- **복합 위협 감지**: 쌍삼, 사삼, 쌍사 패턴 인식 (띈 3·띈 4 포함)
- **전술 계층**: 모든 탐색 노드에서 5목·4·열린3 위협에 따라 후보 수를 강제 제한
- **평가 캐시**: 라인·군집·말단 평가를 해시로 캐싱해 깊은 탐색 가능

### 대시보드
- **게임 통계**: 총 게임, 승률, 모드별 분포
- **패턴 학습**: 1차원 선형 패턴의 Attack/Defense 가중치 변화 추적
- **복합 위협**: 쌍삼/사삼/쌍사 발생 통계
- **군집 패턴**: 2차원 군집 형태(ㅗ, +, X, L자 등) 학습 현황
- **군집 연결**: 영향력 맵 기반 연결 패턴 통계
- **학습 진행**: 패턴별 학습 문턱 도달 현황
- **기보 재생**: 저장된 게임 재생
  - 돌 안에 수 순서 표시 (1, 2, 3...)
  - 흑돌: 흰색 숫자, 백돌: 검정 숫자
  - 일반 패턴: 빨간색 라인 (rgba(255, 99, 71, 0.5))
  - 복합위협: 라임색 라인 (rgba(0, 255, 0, 0.5))

## 기술 스택

- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Backend**: Python Flask
- **Database**: SQLite
- **AI**: MiniMax + Alpha-Beta + Zobrist Hashing + Transposition Table

## 설치 및 실행

### 요구사항
- Python 3.8+
- Flask

### 설치

```bash
git clone <repository-url>
cd omok
pip install flask
```

### 실행

**게임 서버** (포트 8081):
```bash
python3 server.py
```

**대시보드 서버** (포트 8082):
```bash
python3 dashboard/app.py
```

접속:
- 게임: http://localhost:8081
- 대시보드: http://localhost:8082

### 초기화

서버 최초 실행 시:
1. 데이터베이스 테이블 자동 생성
2. 기본 패턴 가중치 초기화
3. **기존 저장된 게임 자동 재분석** (복합위협, 군집 패턴, 군집 연결)

## 프로젝트 구조

```
omok/
├── index.html           # 게임 메인 HTML
├── style.css            # 레트로 스타일 CSS
├── game.js              # 게임 로직
├── ai.js                # AI 엔진 (MiniMax + 학습 + 군집 패턴)
├── board-renderer.js    # 공통 보드 렌더링 모듈
├── server.py            # 게임 백엔드 서버
├── tests/ai.test.js     # AI 전술 테스트 (node --test tests/ai.test.js)
├── tools/match/         # Gomoku-MiniMax 대국 하네스 (match.py, summary.py, bench.js)
├── weights_config.json  # 패턴 가중치 설정 (단일 소스)
├── weights.json         # 동적 학습 가중치
├── game.db              # SQLite 데이터베이스
├── font.woff2           # 커스텀 한글 폰트
├── stone.wav            # 돌 놓기 효과음
└── dashboard/
    ├── app.py           # 대시보드 백엔드
    ├── templates/
    │   └── index.html   # 대시보드 HTML
    └── static/
        ├── style.css    # 대시보드 스타일
        ├── script.js    # 대시보드 로직
        ├── board-renderer.js
        └── font.woff2   # 폰트 (복사본)
```

## 게임 방법

1. **시작 화면**: 연습, 챌린지, 랭크 중 선택
2. **연습 모드**: 흑/백 선택 후 시작. **챌린지 모드**: 아이디 입력, 흑/백 선택 후 시작
3. **게임 플레이**:
   - 흑이 먼저 둡니다. 백을 고르면 AI가 흑으로 첫 수를 둡니다
   - 상태 칸(연습): 차례인 쪽의 돌 불빛, 현재 수 번호, AI·Jev가 계산 중일 때 켜지는 불빛
   - 상태 칸(챌린지): 차례 글자 + AI·Jev 불빛
   - 빈 칸을 클릭하여 돌 놓기
   - 가로, 세로, 대각선으로 5개 연결하면 승리
4. **점수**: 빠른 시간, 적은 돌로 승리할수록 고득점

## 점수 계산

```
최종 점수 = (기본 점수 + 시간 보너스 + 돌 보너스) × 단계 보너스
```

| 구분 | 설명 |
|---|---|
| 기본 점수 | 단계별 차등 (100 ~ 1500점) |
| 시간 보너스 | 60초 이내 완료 시 초당 2점 |
| 돌 보너스 | 30개 이하 사용 시 개당 3점 |
| 단계 보너스 | 높은 단계일수록 보너스 배율 증가 |

## API 엔드포인트

### 게임 서버 (8081)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leaderboard` | 랭킹 목록 조회 (상위 10명) |
| POST | `/api/leaderboard` | 점수 저장 |
| POST | `/api/game-record` | 기보 저장 + AI 양방향 학습 |
| GET | `/api/weights` | 패턴 가중치 조회 (attack/defense 분리) |
| POST | `/api/weights/reset` | 가중치 초기화 |
| POST | `/api/jev-move` | Jev 직관 레이어 프록시 (아래 참고) |

### Jev 직관 레이어

연습 모드의 **조용한 국면**에서만 [TypeSafe Jev](https://docs.typesafe.ai)를 함께 씁니다. "코드가 계산하고 Jev가 판단한다" 구조입니다.

1. `ai.js`의 `getAIMoveAnalysis()`가 평소대로 탐색합니다. 5목, 4 막기, 열린3 대응, 확정 승패처럼 강제되는 국면이면 그 수를 바로 둡니다 (Jev 호출 없음).
2. 조용한 국면이면 상위 후보 8개를 같은 깊이로 다시 점수화해 서버에 보냅니다.
3. 서버(`/api/jev-move`)가 보드를 텍스트로 만들어 Jev에 Choice 질문을 보냅니다. 클라이언트의 자유 텍스트는 API로 전달되지 않습니다.
4. `jev.js`가 `alpha × Jev 확률 + (1 − alpha) × 정규화된 MiniMax 점수`로 최종 수를 고릅니다. 최선수보다 `safetyMargin` 이상 나쁜 후보는 처음부터 제외합니다.
5. 키가 없거나, 시간 초과·오류가 나면 MiniMax 수를 그대로 둡니다. 키가 없으면 그 세션에서는 다시 묻지 않고, 일시 오류면 60초 쉰 뒤 재시도합니다.

설정:
- 서버 환경변수 `TYPESAFE_API_KEY` (필수, TypeSafe 콘솔에서 발급). 선택: `JEV_MODEL` (기본 `jev-latest`), `JEV_API_URL`.
- 동작 파라미터는 `jev.js`의 `JEV_CONFIG` (`modes`, `alpha`, `safetyMargin`, `candidates`, `timeoutMs`). 챌린지 모드는 Jev 없이 단계별 강도의 Rapfi만 둡니다.
- 요청의 `aiColor`(`black`/`white`, 기본 `white`)로 AI의 돌 색을 알려 줍니다. 응답 `outcome`은 실제 색(`black`/`white`) 기준입니다.
- 브라우저 콘솔의 `jevStats`에서 호출·교체·폴백 횟수를 볼 수 있습니다.

### Rapfi 엔진

연습·챌린지 모드의 수는 [Rapfi](https://github.com/dhbloo/rapfi)(Gomocup 우승 엔진, `rapfi/`)가 계산합니다.

- `rapfi-worker.js`가 Web Worker에서 WebAssembly 엔진을 띄우고 Gomocup/Yixin 텍스트 프로토콜로 대화합니다. 규칙은 자유룰(`INFO RULE 0`), 수당 0.7초, 상위 6수(`YXNBEST 6`)와 후보별 승률을 받습니다.
- `rapfi.js`는 연습·챌린지 화면에 처음 들어갈 때 엔진(약 41MB, 신경망 가중치 포함)을 백그라운드로 내려받습니다. 준비 전이거나 실패하면 기본 MiniMax(`ai.js`)가 둡니다. 모드 표시에 진행률이 나옵니다.
- `jev.js`의 `chooseAIMove()`가 Rapfi 후보를 Jev에 보냅니다. Rapfi 1순위보다 승률이 10%p 넘게 낮은 후보는 제외하고(`rapfiSafetyMargin`), 남은 후보가 하나뿐이거나 승패가 확정된 국면이면 Jev 없이 Rapfi 수를 둡니다.
- 챌린지 모드는 `rapfi.js`의 `RAPFI_LEVELS`로 단계별 강도를 정합니다: 최대 탐색 깊이(`INFO MAX_DEPTH`), 수당 시간, 보고받는 후보 수, 1순위 대비 허용 승률 차(`tolerance`, 그 안에서 무작위), 실수 확률(`blunder`, 보고된 후보 아무거나). 바로 5목이 되는 수(자기 승리·상대 5목 막기)는 단계와 관계없이 반드시 둡니다. 엔진이 내려받는 중이면 AI 차례에 최대 20초 기다리고, 그래도 안 되면 기존 MiniMax(`LEVEL_CONFIG.timeLimit`)가 둡니다.

| 단계 | 깊이 | 시간 | 후보 | 허용 차 | 실수 | 기본 MiniMax(0.2초, 흑) 상대 백 승률* |
|---|---|---|---|---|---|---|
| 1 | 1 | 0.15초 | 8 | 35%p | 35% | 15% |
| 2 | 2 | 0.15초 | 8 | 25%p | 22% | 20% |
| 3 | 2 | 0.2초 | 7 | 20%p | 18% | 30% |
| 4 | 3 | 0.25초 | 6 | 12%p | 10% | 40% |
| 5 | 4 | 0.3초 | 6 | 12%p | 8% | 60% |
| 6 | 5 | 0.35초 | 5 | 7%p | 4% | 60% |
| 7 | 6 | 0.4초 | 4 | 5%p | 3% | 65% |
| 8 | 8 | 0.5초 | 3 | 3%p | 1% | 85% |
| 9 | 10 | 0.7초 | 2 | 1%p | 0% | 95% |
| 10 | 제한 없음 | 2초 | 1 | 0%p | 0% | 100%† |

\* 자체 대국 측정(단계당 20국, 첫 두 수 무작위). 사람 체감과는 다를 수 있습니다. 10단계 대 8단계: 10단계가 흑이면 20전 20승, 백이면 20전 6승(흑 선공 이점이 큼).
† 1초 설정으로 측정. 현재는 2초(최대 강도)라 그 이상입니다.

### 대시보드 서버 (8082)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | 게임 통계 |
| GET | `/api/patterns` | 패턴 학습 현황 (attack/defense) |
| GET | `/api/composite-stats` | 복합 위협 통계 |
| GET | `/api/cluster-stats` | 군집 패턴 통계 |
| GET | `/api/cluster-connection-stats` | 군집 연결 통계 |
| GET | `/api/cluster-weights` | 군집 패턴 가중치 (AI용) |
| GET | `/api/learning-progress` | 학습 진행률 |
| GET | `/api/weight-history` | 가중치 변화 이력 |
| GET | `/api/leaderboard` | 리더보드 |
| GET | `/api/games` | 게임 목록 |
| GET | `/api/game/<id>` | 특정 게임 기보 |
| GET | `/api/game/<id>/patterns` | 게임 내 패턴 (일반+복합위협) |

## AI 알고리즘

### 탐색 알고리즘
- **MiniMax**: 모든 가능한 수를 탐색하여 최적의 수 선택
- **Alpha-Beta 가지치기**: 불필요한 탐색 제거
- **Iterative Deepening**: 시간 제한 내 최대 깊이 탐색
- **Killer Moves**: 좋은 수를 우선 탐색
- **Transposition Table**: 중복 보드 상태 캐싱
- **Zobrist Hashing**: 64비트 보드 해싱
- **위협 기반 후보 제한** (루트와 내부 노드 공통, 둘 차례 기준):
  1. 내가 5목을 만들 수 있으면 그 수만
  2. 상대 5목 자리가 있으면 막는 수만
  3. 내가 열린4·쌍사를 만들 수 있으면 그 수만, 사삼이면 그 수 + 예비 5수
  4. 상대가 다음 수에 열린4·쌍사·사삼·쌍삼을 만들 수 있으면 막는 수 + 4로 맞받는 수 + 예비 5수
  5. 그 외에는 정렬 상위 12수
- **외길 연장**: 후보가 1개인 노드는 깊이를 깎지 않음 (경로당 최대 8회)
- **종료 판정**: 직전 수의 5목 여부로 판정, 승리 = `1e9 + 남은 깊이` (빠른 승리 선호)
- **차례를 아는 말단 평가**: 둘 차례가 5목 자리를 가지면 승리, 상대가 5목 자리 2개 이상이면 패배,
  둘 차례가 열린4·쌍사·사삼을 만들 수 있고 상대에게 4가 없으면 승리에 가까운 점수

### 전술 계층 (학습 가중치와 무관)
`linePoints` / `classifyMove`가 한 수를 가정하고 4방향 9칸 창을 분석합니다.
- **5목**: 5목 이상 완성 (장목 포함)
- **열린 4**: 한 방향의 5목 자리가 2개 이상 (띈 모양 포함)
- **4**: 5목 자리가 1개 (`XOOOO_`, `OO_OO`, `O_OOO`, `OOO_O`)
- **열린 3**: 한 수 더 두면 열린 4가 되는 모양 (`_OOO_`, `_O_OO_`, `_OO_O_`)
- **등급**: 5목 > 열린4·쌍사 > 사삼 > 쌍삼 > 4 > 열린3

전술 판정은 고정 규칙이며 학습 가중치는 위치 평가(라인 + 군집)에만 쓰입니다.

### 평가 함수

#### 1차원 패턴 평가
- **배타적 패턴 매칭**: 중복 카운팅 방지
- **Attack/Defense 분리**: AI 돌은 공격, 플레이어 돌은 방어 관점 평가
- **띈 4**: `OO_OO`, `O_OOO`, `OOO_O`는 패턴 키가 없으므로 빈칸마다 `OOOO_`(닫힌4)의 학습 가중치를 더함

| 패턴 | 기본 가중치 |
|------|------------|
| OOOOO (오목) | 100,000 |
| _OOOO_ (열린4) | 50,000 |
| OOOO_, _OOOO (닫힌4) | 10,000 |
| _OOO_ (열린3) | 5,000 |
| OOO__, __OOO (열린3 끝) | 1,000 |
| _O_OO_, _OO_O_ (띄운3) | 1,000 |
| OO__, __OO (열린2) | 100 |
| _OO_ (닫힌2) | 100 |
| O__, __O (열린1) | 10 |

#### 복합 위협 평가
| 패턴 | 가중치 | 설명 |
|------|--------|------|
| double_open_three | 30,000 | 쌍삼 (두 개의 열린3) |
| four_three | 40,000 | 사삼 (4+3) |
| double_four | 90,000 | 쌍사 (두 개의 4) |

#### 2차원 군집 패턴 평가
8방향 연결된 돌 그룹을 식별하여 형태 분석:

| 패턴 | 가중치 | 설명 |
|------|--------|------|
| three_way_up | 3,000 | ㅗ 형태 (삼방향 위) |
| three_way_down | 3,000 | ㅜ 형태 (삼방향 아래) |
| three_way_left | 3,000 | ㅓ 형태 (삼방향 왼쪽) |
| three_way_right | 3,000 | ㅏ 형태 (삼방향 오른쪽) |
| cross_plus | 5,000 | + 형태 (십자가) |
| cross_x | 5,000 | X 형태 (대각선 십자) |
| corner_l_1~4 | 2,000 | L자 형태 (코너) |
| t_shape_1~2 | 2,500 | T자 형태 |

#### 영향력 맵 기반 연결 평가
각 돌이 주변에 미치는 영향력을 계산하여 연결 가능성 평가:

| 연결 타입 | 가중치 | 설명 |
|----------|--------|------|
| nearby_threes | 4,000 | 두 열린3이 근접 |
| bridge_threat | 8,000 | 한 수로 두 패턴 연결 |
| supporting_threat | 3,000 | 한 패턴이 다른 패턴 지원 |
| pincer_threat | 3,500 | 두 패턴이 상대 협공 |

### 평가 캐시
평가는 증분(delta) 방식이 아니라 말단(depth 0)에서만 전체를 계산하고, 결과를 캐싱합니다.
- **라인 점수**: 줄 내용(3진 코드 + 길이 + 관점)을 키로 메모이즈. 대부분의 줄은 말단 사이에 바뀌지 않음
- **군집 패턴**: 플레이어별 Zobrist 해시로 캐싱
- **군집 연결**: 3·4를 만들 수 있는 칸은 항상 돌에서 2칸 이내이므로 후보 칸만 분류하고, 영향력은 그 칸에서만 계산
- **말단 결과**: 국면 해시 + 둘 차례로 캐싱
- 캐시는 매 `getAIMove()` 시작 시 비우므로 새로 불러온 학습 가중치가 바로 반영됨
- 내부 노드는 평가하지 않고 직전 수의 5목 여부만 확인

같은 국면 22개 기준(2200ms) 초당 평가 약 790회 → 약 6,700회, 도달 깊이 평균 2.7 → 5.3
(`node tools/match/bench.js`).

## AI 학습 시스템

### 학습 구조

```
┌─────────────────────────────────────────────────────────┐
│                    AI 평가 함수                          │
├─────────────────────────────────────────────────────────┤
│  evaluateLinearPatterns()     ← 1차원 선형 패턴         │
│  evaluateClusterPatterns()    ← 2차원 군집 패턴         │
│  evaluateClusterConnections() ← 영향력 맵 기반 연결     │
└─────────────────────────────────────────────────────────┘
```

### 양방향 학습

AI는 플레이어와 AI 양쪽의 기보를 학습합니다:

| 결과 | 학습 내용 |
|---|---|
| 플레이어 승 | 플레이어 패턴 → 방어(Defense) 강화, AI 패턴 → 공격(Attack) 약화 |
| AI 승 | AI 패턴 → 공격(Attack) 강화, 플레이어 패턴 → 방어(Defense) 약화 |

### 학습 범위

게임 종료 시 다음 패턴들을 자동 추출하여 학습:
1. **1차원 패턴**: `_OOO_`, `OOOO` 등
2. **복합 위협**: 쌍삼, 사삼, 쌍사
3. **2차원 군집 패턴**: ㅗ, +, X, L자 등
4. **군집 연결 패턴**: nearby_threes, bridge_threat 등

### 학습 파라미터

```json
{
  "min_games_threshold": 15,
  "ema_old_weight": 0.85,
  "ema_new_weight": 0.15,
  "min_weight_ratio": 0.3,
  "max_weight_ratio": 3.0,
  "win_multiplier": 1.5
}
```

| 파라미터 | 값 | 설명 |
|---|---|---|
| 학습 문턱 | 15회 | 패턴이 15회 이상 등장해야 학습 시작 |
| EMA 비율 | 0.85/0.15 | 기존 85%, 새 데이터 15% 반영 |
| 가중치 범위 | 0.3x ~ 3.0x | 기본값의 30% ~ 300%로 제한 |
| 승리 가중 | 1.5x | 승리 시 가중치 1.5배 증가 |

### DB 스키마

```sql
-- 1차원 패턴 통계 (attack/defense 분리)
pattern_stats (
    pattern TEXT PRIMARY KEY,
    win_count, total_count, current_weight,
    attack_weight, defense_weight,
    attack_win_count, attack_total_count,
    defense_win_count, defense_total_count
)

-- 가중치 이력
weight_history (
    id INTEGER PRIMARY KEY,
    pattern, attack_weight, defense_weight, 
    game_count, recorded_at
)

-- 복합 위협 통계
composite_pattern_stats (
    id INTEGER PRIMARY KEY,
    pattern_type, game_id, move_number, 
    player, resulted_in_win
)

-- 2차원 군집 패턴 통계
cluster_pattern_stats (
    pattern_id TEXT PRIMARY KEY,
    win_count, total_count,
    attack_weight, defense_weight,
    attack_win_count, attack_total_count,
    defense_win_count, defense_total_count
)

-- 군집 연결 통계
cluster_connection_stats (
    connection_type TEXT PRIMARY KEY,
    win_count, total_count,
    attack_weight, defense_weight,
    attack_win_count, attack_total_count,
    defense_win_count, defense_total_count
)
```

## 설정 파일 (weights_config.json)

```json
{
  "patterns": {
    "OOOOO": 100000,
    "_OOOO_": 50000,
    ...
  },
  "composite_patterns": {
    "double_open_three": 30000,
    "four_three": 40000,
    "double_four": 90000
  },
  "cluster_patterns": {
    "three_way_up": { "weight": 3000, "name": "ㅗ", "desc": "삼방향 위" },
    "cross_plus": { "weight": 5000, "name": "+", "desc": "십자가" },
    ...
  },
  "cluster_connection_patterns": {
    "nearby_threes": { "weight": 4000, "desc": "두 열린3이 근접" },
    "bridge_threat": { "weight": 8000, "desc": "한 수로 두 패턴 연결" },
    ...
  },
  "learning": {
    "min_games_threshold": 15,
    "ema_old_weight": 0.85,
    "ema_new_weight": 0.15,
    "min_weight_ratio": 0.3,
    "max_weight_ratio": 3.0,
    "win_multiplier": 1.5
  },
  "phases": {
    "opening": { "max_move": 10 },
    "midgame": { "max_move": 30 },
    "endgame": { "max_move": 225 }
  }
}
```

## 보안

- **입력 검증**: name 길이 제한, score/level/stones 범위 검사
- **파일 접근 제한**: `.db`, `.py` 파일 직접 접근 차단
- **XSS 방지**: 모든 사용자 입력 이스케이프 처리

## 브라우저 지원

- Chrome (권장)
- Firefox
- Safari
- Edge

## AI 테스트와 대국 측정

```bash
node --test tests/                              # 전체 테스트 (전술, Jev, Rapfi 실제 엔진 구동)
python3 tools/match/match.py 50 2200 3         # 시작 국면 50개 × 흑백 = 100판
python3 tools/match/summary.py tools/match/*.jsonl
node tools/match/bench.js ai.js 2200           # 초당 평가 횟수와 도달 깊이
```
`match.py`는 상대 엔진을 `tools/match/vendor/`에 클론하며, 한 번에 한 대국씩 둡니다.

## 라이선스

MIT License (이 프로젝트의 자체 코드)

`rapfi/` 디렉터리의 Rapfi 엔진은 이 프로젝트의 코드가 아니며 **GPL-3.0**으로 배포됩니다.
소스 위치와 받은 경로는 [rapfi/README.md](rapfi/README.md), 라이선스 전문은 [rapfi/COPYING.txt](rapfi/COPYING.txt)에 있습니다.
게임은 Web Worker의 텍스트 프로토콜로만 엔진과 통신합니다.

### 출처
AI의 위협 등급(5목 > 열린4 > 쌍사 > 사삼 > 쌍삼 > 4 > 열린3), 띈 모양을 4·3으로 보는 구간 분석,
등급 기반 후보 제한(예비 후보 5개), 외길 연장, 깊이를 더한 승리 점수는
[Gomoku-MiniMax](https://github.com/yups1199/Gomoku-MiniMax)
(MIT License, Copyright (c) 2026 JeongYupKim)의 `model.py`, `heuristic_weights.py`를 참고해
다시 구현했습니다.
