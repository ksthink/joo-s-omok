# 주군의 한수

오목 AI와 대결하는 레트로 스타일의 웹 게임입니다. AI가 플레이어의 기보를 학습하여 점점 강해집니다.

## 소개

"주군의 한수"는 인공지능과 대결하는 오목 게임입니다. 연습 모드에서 실력을 키우고, 챌린지 모드에서 10단계의 AI를 상대로 점수를 기록하세요. AI는 매 게임 후 학습하여 시간이 지날수록 더 강해집니다.

## 기능

### 게임 모드
- **연습 모드**: 자유롭게 AI와 대결하며 실력 향상
- **챌린지 모드**: 10단계 난이도 도전, 점수 기록
- **랭킹**: 상위 10명 기록 확인

### AI 특징
- **MiniMax + Alpha-Beta**: 최적의 수 탐색
- **양방향 학습**: 공격(Attack)과 방어(Defense) 가중치 분리 학습
- **1차원 패턴 학습**: 선형 패턴(열린3, 열린4 등) 학습
- **2차원 군집 패턴 학습**: ㅗ, +, X, L자, T자 등 군집 형태 학습
- **영향력 맵 기반 연결 학습**: 군집 간 연결 가능성 평가
- **복합 위협 감지**: 쌍삼, 사삼, 쌍사 패턴 인식
- **증분 평가**: 빠른 보드 평가로 깊은 탐색 가능

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
2. **챌린지 모드**: 아이디 입력 후 게임 시작
3. **게임 플레이**:
   - 당신은 흑돌 (선공)
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

### 평가 함수

#### 1차원 패턴 평가
- **배타적 패턴 매칭**: 중복 카운팅 방지
- **Attack/Defense 분리**: AI 돌은 공격, 플레이어 돌은 방어 관점 평가

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

### 증분 평가
- 전체 보드 스캔 대신 delta 계산으로 50배+ 속도 향상

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

## 라이선스

MIT License
