# PeerLetter

[![English](https://img.shields.io/badge/lang-English-blue)](README.md)
[![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](README.ko.md)

> 이 문서는 [README.md](README.md)의 한국어판입니다. 내용이 다르면 README.md를 기준으로 합니다. 전역 설치와 Claude 세션 전환 개선을 함께 반영했습니다.

같은 로컬 작업 공간에서 일하는 에이전트들이 **stdio MCP + 공유 SQLite**로 메일을 주고받습니다. 메일은 디스크에 남습니다. 클라이언트마다 자기 프로세스를 띄우므로, 리스너·포트·토큰 서비스·Pi 호스트가 필요 없습니다.

이 저장소는 **pnpm을 쓰는 GitHub clone 기반 테스트**용입니다. 레지스트리와 마켓플레이스 배포는 막혀 있습니다. Node **24.18 이상**이 TypeScript 소스를 바로 실행하므로 빌드가 필요 없습니다.

## 사용자 전역 설치

```bash
git clone https://github.com/crazylulu-c2sh/PeerLetter.git ~/dev/PeerLetter
~/dev/PeerLetter/setup all
# 하나만 고르려면: setup claude | setup codex | setup pi
```

`setup`은 PATH와 일반적인 nvm 설치에서 Node **24.18 이상**을 찾아 실제 절대 경로를 고정합니다. **pnpm 10 이상 또는 Corepack**으로(pnpm이 `packageManager` 버전으로 알아서 전환합니다) `--frozen-lockfile --ignore-scripts` 설치를 수행합니다. 빌드나 의존성 빌드 승인은 필요 없습니다. Node·pnpm이 없으면 설치 방법을 출력하고 종료합니다. `PEERLETTER_NODE=/absolute/path/to/node`로 Node를 직접 고를 수도 있습니다. Bash가 필요합니다. 설치된 체크아웃 경로를 유지하고, 경로나 Node 설치가 바뀌면 setup을 다시 실행하세요.

사용자의 **모든 프로젝트에서** 쓸 깨우기와 PeerLetter skill을 설치합니다. 설치 확인, 작업 공간 SQLite `doctor` 결과, 비공개 백업 경로, 현재 디렉토리의 기존 프로젝트 설정 충돌, 호스트에서 마칠 단계를 읽기 쉬운 보고서로 출력합니다. `--json`을 붙이면 전체 결과를 stdout에 JSON으로 출력하고, 진행 메시지는 stderr로 보냅니다. 관계없는 설정은 보존합니다. Claude에는 비공개 디렉토리 카탈로그를 쓰며, 업로드나 배포는 하지 않습니다.

| 호스트 | 사용자 설정 | 기본 깨우기 | 호스트에서 마칠 단계 |
|---|---|---|---|
| Claude | `~/.claude/peerletter-plugin`, 사용자 플러그인 등록, `~/.claude/peerletter.json` | `claude-monitor` | 플러그인·작업 공간 신뢰 승인. 첫 설치는 다시 불러오기, 기존 MCP 런타임 업데이트는 재시작. `whoami.wake_runner.online` 확인. |
| Codex | `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.agents/skills/peerletter` | `codex-queue` | `/hooks` 검토 후 MCP 재연결 또는 새 세션. Codex에게 PeerLetter 사용을 요청해 첫 whoami로 실제 thread 연결. |
| Pi | `~/.pi/agent/settings.json`, Node 경로를 고정한 확장, skill 경로 | `pi-extension` | `/reload` 또는 재시작. 사용자 확장·skill은 프로젝트 신뢰 전에 로드되며 프로젝트 리소스 신뢰는 별도. Pi 자체도 Node 24.18 이상 필요. |

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `XDG_STATE_HOME`으로 기본 경로를 바꿀 수 있습니다. 설치 소유권은 `$XDG_STATE_HOME/peerletter/installation.json`에 기록합니다. 기본은 `~/.local/state/peerletter/installation.json`입니다. 프로젝트와 참가자 이름은 고정하지 않으며, 실행 중인 각 세션의 작업 디렉토리·Git 루트에 참여합니다. Codex는 기존 로컬 앱서버 소켓으로 호출한 실제 thread의 cwd만 읽습니다. 소켓에 연결할 수 없으면 데몬의 cwd를 선택하지 않고 오류를 보고합니다. 다른 통합을 위한 프로젝트 고정 설치는 아래에 남아 있습니다.

에이전트들을 **같은 프로젝트**에서 열고 이렇게 요청하세요.

> PeerLetter 사용해서 다른 에이전트와 통신해줘.
>
> Use PeerLetter to communicate with the other agents.

skill은 **whoami → peers**를 호출하고 실제 이름·참가자·세션 연결·깨우기 상태를 보고한 뒤 메일을 받습니다. PeerLetter를 사용한 세션만 참여합니다. 자동 깨우기를 설치했더라도 PeerLetter 도구를 한 번도 호출하지 않은 세션은 참여자로 나타나지 않고, 사용한 적이 있는 세션은 MCP 재연결·재시작·resume 뒤 자동으로 다시 참여합니다. 첫 whoami는 **에이전트가 호출하는 MCP 도구**이며 셸의 `whoami` 명령이 아닙니다. Codex는 새 MCP 연결마다 첫 호출이 필요합니다. 전역 설치만으로 공유 데몬의 thread를 알아낼 수는 없습니다. `/mcp`는 상태만 보여 주며 서버를 재시작하지 않습니다. Codex 0.160.0에서는 TUI 종료, 의도적인 공유 앱서버 데몬 재시작, 같은 thread resume으로 MCP를 다시 연결할 수 있습니다. 데몬 재시작은 다른 클라이언트 연결도 끊습니다.

기존 프로젝트 로컬 PeerLetter 설정은 전역 설정을 덮거나 경쟁할 수 있습니다. setup은 현재 디렉토리의 관련 파일을 안내하지만 프로젝트를 수정하거나 다른 체크아웃들을 검색하지 않습니다. 전환 전에 백업하고, 기존 PeerLetter MCP·플러그인·훅·확장·skill 항목만 제거하거나 비활성화하세요. 다른 설정은 유지하세요. 이전에 설치한 다른 프로젝트도 확인하세요. 프로젝트 `.claude/peerletter.json`에 `none`이 남으면 전역 monitor를 멈출 수 있으므로, 전환할 때 이 소유 설정 파일도 갱신하거나 제거하세요. 같은 세션에 PeerLetter MCP를 두 개 실행하지 마세요.

```bash
~/dev/PeerLetter/setup all --preview         # 의존성·설정 변경 없이 미리 보기
~/dev/PeerLetter/setup --uninstall all      # 또는 claude, codex, pi
```

삭제는 소유한 MCP·훅·확장·skill 항목과 사용자 Claude 플러그인·카탈로그를 제거하며, 나중에 추가한 다른 설정은 보존합니다. 실행 중인 Claude monitor는 먼저 멈춥니다. 이미 떠 있는 MCP 연결은 호스트를 다시 불러오거나 재시작해 끊으세요. 백업은 비공개로 남습니다. 편집된 생성 파일은 보존하고 보고하며, 관리 중인 Codex 블록을 편집했다면 삭제 전에 검토해야 합니다. 과거 전체 설정으로 나중의 사용자 변경을 덮어쓰지 않습니다. 설치·삭제는 작업 공간 DB의 메일이나 lease를 삭제하지 않습니다.

### 업데이트

```bash
~/dev/PeerLetter/setup update               # --preview는 들어올 커밋과 변경 계획만 보여 줍니다
```

`setup update`는 이 체크아웃을 upstream 브랜치로 fast-forward하고, 고정된 lockfile로 의존성을 설치한 뒤, 설치 기록에 있는 모든 agent를 갱신합니다. 생성된 Claude 플러그인과 skill 사본, Codex·Pi 항목, 고정된 Node 경로가 대상입니다. 나머지 과정은 갱신된 setup 스크립트가 이어서 실행합니다.
- 추적 중인 파일에 로컬 변경이 있거나, 브랜치에 upstream이 없거나, upstream에 없는 커밋이 있으면 아무것도 바꾸지 않고 멈춥니다.
- 끝나면 Claude를 재시작하고(플러그인 다시 불러오기로는 실행 중인 MCP가 바뀌지 않습니다), Codex MCP를 다시 연결하거나 새 세션을 열고, Pi는 `/reload`하세요.
- 프로젝트 로컬 설치는 갱신하지 않습니다. 그 경우 `scripts/install.ts --project DIR --apply`를 다시 실행하세요.

### 체크아웃 검증·개발

```bash
cd ~/dev/PeerLetter
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
```

런타임 의존성은 MCP SDK·Zod·`ws`입니다. SQLite는 Node에 내장되어 있습니다. Pi SDK는 확장 검사에 쓰는 개발 의존성입니다. 레지스트리 배포는 꺼져 있습니다.

## 이미 실행 중인 에이전트로 테스트

현재 작업 공간용 래퍼와 안내문을 준비합니다.

```bash
node ~/dev/PeerLetter/scripts/prepare.ts --project /path/to/project
```

이 명령은 `output/peerletter-test/peerletter`, `AGENT-PROMPT.txt`, 짧은 안내서를 만듭니다. 빈 작업 공간 DB를 초기화하고, 메일은 보내지 않습니다. 참여할 에이전트마다 안내문을 전달하고 서로 다른 이름을 고르게 하세요.

```bash
MAIL=/path/to/project/output/peerletter-test/peerletter

# 각 등록은 해당 참여자가 직접 실행합니다.
"$MAIL" --name codex-review register
"$MAIL" --name claude-build register
"$MAIL" peers

"$MAIL" --name codex-review send --to claude-build \
  --text 'PeerLetter connection test' --idempotency-key test-001
"$MAIL" --name claude-build receive
# 메일을 처리한 뒤 전체 UUID를 복사해 ACK합니다.
"$MAIL" --name claude-build ack <MESSAGE_UUID>
"$MAIL" --name codex-review status <MESSAGE_UUID>
```

`register`는 오프라인 메일함을 만듭니다. 그 이름으로 온 메일은 보존되며, CLI로 바로 읽을 수 있습니다.
- **온라인으로 표시하려면:** 별도 터미널에서 `"$MAIL" --name codex-review --kind codex serve`를 실행하고, Ctrl-C로 멈춥니다.
- **같은 메일 다시 받기:** `receive`는 ACK하기 전까지 같은 메일을 계속 돌려줍니다.
- **답장하기:** `send --reply-to <MESSAGE_UUID>`에 새 고정 키를 붙입니다.

이미 떠 있는 호스트 세션은 이 CLI를 바로 쓸 수 있습니다. 새 MCP 도구를 쓰려면 Codex·Claude는 새 세션을 열거나 호스트의 재연결 절차를 거쳐야 하고, Pi는 `/reload`를 쓰면 됩니다.

## 프로젝트 로컬 설치 (선택)

설치 스크립트는 **프로젝트 로컬** 설정을 미리 보여 줍니다. 다른 서버 항목, 설정, 훅 처리기는 그대로 둡니다. 생성될 파일을 검토한 뒤 적용합니다.

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project --apply
```

| 클라이언트 | 프로젝트 파일 | Skill |
|---|---|---|
| Codex | `.codex/config.toml`, `.codex/hooks.json` | `.agents/skills/peerletter` |
| Claude | `.mcp.json`, `.claude/settings.local.json` | `.claude/skills/peerletter` |
| Pi | `.pi/mcp.json` | `.pi/skills/peerletter` |

**백업과 되돌리기**
- 바뀐 파일은 `.backup-<timestamp>-<id>` 이름의 비공개 사본으로 백업됩니다.
- 다시 실행하면 Codex 관리 블록이나 같은 체크아웃의 항목을 갱신합니다.
- 충돌하는 skill 링크나 관계없는 PeerLetter 등록은 거부합니다.
- 되돌리려면 백업을 복원하거나, 생성된 항목과 그 훅 처리기를 지우세요.
- skill 링크는 이 체크아웃을 가리킵니다. 로컬 설정에는 절대 경로가 들어가므로, 경로가 기기마다 다르다면 공유 프로젝트의 커밋에 넣지 마세요.

**호스트 신뢰 규칙은 그대로 적용됩니다.** 설치 스크립트는 호스트의 신뢰 결정을 바꾸지 않습니다.
- **Claude:** 프로젝트 MCP 서버를 승인합니다.
- **Pi:** `/trust`로 이 프로젝트의 신뢰를 저장한 뒤 `/reload`합니다. `pi -a`는 그 실행에만 신뢰를 주며, 이미 실행 중인 세션이 프로젝트 MCP 설정을 신뢰하게 만들지는 않습니다.
- **Codex:** `/hooks`에서 훅을 검토합니다. 새로 생기거나 바뀐 훅은 검토 전까지 건너뜁니다. 프로젝트 설정도 신뢰된 프로젝트여야 적용됩니다.

자세한 내용은 [Codex 훅 공식 문서](https://learn.chatgpt.com/docs/hooks), [Claude 훅 레퍼런스](https://code.claude.com/docs/en/hooks), [Pi 프로젝트 신뢰 문서](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md#project-trust)를 참고하세요.

기본값은 세 클라이언트 모두 받은편지함을 직접 확인하는 방식입니다. 연결한 뒤 보내기 전에 `peerletter_whoami`와 `peerletter_peers`로 프로젝트와 이름을 확인하세요.
- **Claude 수동 모드:** 작업 중에는 PostToolUse가, 턴이 끝날 때는 Stop이 새 메일을 알립니다.
- **Claude 자동 모드:** 알림 장치 하나만 쓰고 위 알림들은 끕니다.
- 알림에는 본문이 없고, 알림이 ACK하지도 않습니다.

### 참여와 메일함 이름

**`wake=none`이면 첫 PeerLetter 도구 호출 때 참여합니다.**
- 초기화나 `tools/list`만으로는 이름을 예약하지 않고 감시도 시작하지 않습니다. 호스트 세션 ID를 알고 있어도 마찬가지입니다.
- 그래서 쓰지 않는 수동 클라이언트, 불러오기만 한 thread, 서브에이전트가 참여자로 나타나지 않습니다.
- 아직 참여하지 않은 세션도 훅은 문제없이 처리합니다.
- MCP 안내문은 사용자가 PeerLetter를 요청했거나 이 세션이 이미 참여 중일 때만 도구를 호출하라고 지시합니다. 어떤 호출이든 참여로 이어지기 때문입니다. 같은 이유로 읽기 전용(read-only)으로 표시한 도구는 없고, `ack`·`lease_release`·`bind_session`은 destructive로 표시합니다.
- PeerLetter를 사용한 적 없는 작업 공간에서는 훅, Claude monitor·async-rewake 대기 프로세스, Pi 확장이 아무것도 기록하지 않고 DB도 만들지 않습니다. 첫 PeerLetter 호출이 DB를 만든 뒤에 붙습니다.

**깨우기를 켜면 다르게 동작합니다.** 실제 호스트 세션을 알 수 있고 **PeerLetter를 사용한 적이 있는** 연결은 MCP 초기화 직후 참여하고, **도구 호출 없이** 깨우기 장치를 시작합니다.
- PeerLetter 도구를 한 번도 호출하지 않은 세션(새 Claude·Pi 세션, Pi `/new`, Claude `/clear`)은 수동 클라이언트처럼 첫 도구 호출 전까지 참여하지 않습니다.
- 첫 도구 호출이 그 호스트 세션을 작업 공간 DB에 "사용함"으로 기록합니다. 이후 같은 세션의 연결(재연결, resume으로 재시작, `/resume`)은 자동으로 참여합니다.
- 참여하지 않기로 한 시작은 DB를 만들지 않습니다.

| 클라이언트 | 시작 시 등록에 인정하는 신원 |
|---|---|
| Claude monitor / async-rewake / channel | `CLAUDE_CODE_SESSION_ID` 또는 명시적으로 설정한 세션 (watch 방식은 UUID 필요) |
| Pi 확장 | 확장이 `--session`으로 넘기는 실제 세션 ID. Pi는 시작할 때 확장 MCP 서버에 연결합니다 |
| Codex queue | 이 MCP 연결을 의도적으로 고정한 명시적 `--session <thread UUID>` |

**신원이 없거나, 유효하지 않거나, 임시 값이면 지연 등록을 유지합니다.**
- Claude의 PID 레지스트리와 훅으로만 얻은 신원은 시작 시 등록에 쓰지 않습니다.
- Codex에서 물려받은 `CODEX_THREAD_ID`·`PEERLETTER_SESSION_ID`와 PID 훅 매핑으로는, 쓰이지 않은 연결을 공유 데몬의 어느 thread가 불러왔는지 증명할 수 없습니다.
  - 매핑 테이블은 PID마다 최신 세션 하나만 저장합니다. **행이 하나라고 thread가 하나라는 뜻은 아닙니다.**
  - 그래서 일반 Codex 연결은 여전히 첫 도구 호출의 기본 `_meta.threadId`가 필요합니다.
- 관계없는 여러 thread가 쓰는 공유 설정에 고정 `--session`을 넣지 마세요. 의도적으로 관리하는 연결에만 씁니다.

**`peerletter_whoami`로 정확한 이름, 연결 상태, 깨우기 상태를 확인하세요.**
- `registration.mode`는 `startup`(도구 호출 없이 참여) 또는 `tool-call`입니다.
- 사용한 적 없는 세션이라 시작 시 등록을 미루면 stderr에 한 번 기록하고 재시도하지 않습니다.
- 그 밖의 이유로 시작 시 등록이 실패하면 stderr에 기록하고, 횟수와 간격을 제한해 재시도합니다. 도구 호출은 원래 오류를 돌려주며 역시 재시도할 수 있습니다.
- 살아 있는 소유자를 밀어내지 않습니다. 같은 세션을 새 연결이 가져가려면 다시 불러오기(reload)로 이전 연결을 먼저 닫아야 합니다.
- 시작 시 참여한다고 해서 호스트의 channel 권한이나 훅 신뢰가 생기지는 않습니다.

**자동 이름(`codex`, `codex-2`, `claude`, `pi` 등)은 원래 호스트 세션 전용입니다.**
- 같은 세션 ID로 다시 연결하면 그 세션의 오프라인 자동 이름을 다시 씁니다.
- 다른 세션은 쓰이지 않은 새 이름을 받습니다. 이전 프로세스가 오프라인이고 받은편지함에 안 읽은 메일이 있어도 마찬가지입니다.
- 연결되지 않은 `runtime:...` 신원은 이전 자동 이름을 다시 쓸 수 없습니다.
- 항상 whoami가 돌려준 정확한 이름을 쓰세요.

**오래 유지할 역할 메일함이 필요하면 `PEERLETTER_NAME`을 지정하세요.**
- 클라이언트 하나만 설치할 때는 파일 MCP 설정에 `--name`도 쓸 수 있습니다.
- Pi 확장 방식은 Pi를 실행할 때의 `PEERLETTER_NAME`에서 역할 이름을 가져옵니다. 확장까지 전달되지 않는 설치 스크립트의 `--name`은 거부합니다.
- 오프라인 역할 이름을 명시적으로 다시 쓰면, 특정 세션을 지정하지 않은 미확인 메일을 의도적으로 이어받습니다. 자동 할당이 명시적 역할 메일함을 가져가는 일은 없습니다.
- 이름 소유자가 살아 있으면 `NAME_IN_USE`, 같은 호스트 세션에 두 번째 연결이 살아 있으면 `SESSION_IN_USE`를 돌려줍니다.
- 살아 있는 런타임의 소유권은 넘어가지 않습니다. 소유자 연결이 끊긴 뒤 도구를 다시 호출하면 등록할 수 있습니다.

**`whoami`와 `peers`가 보여 주는 정보**
- `naming`: `automatic`, `explicit`, `legacy` 중 하나입니다.
- `session_binding`: `bound` 또는 `unbound`와 그 출처입니다.
- `online`: 등록된 MCP 프로세스가 살아 있다는 뜻입니다. TUI가 붙어 있거나 메일을 읽는다는 뜻은 아닙니다.
- 기존 `legacy` 메일함은 그대로 남고, 관계없는 세션에 자동으로 다시 배정되지 않습니다. 업데이트한 뒤에는 이전 MCP 프로세스를 다시 연결해야 이 등록 정책이 적용됩니다.

참여자에 호스트 신원이 한번 연결되면, 같은 연결에서 다른 신원이 오면 `SESSION_MISMATCH`를 돌려줍니다. 새 세션을 등록하려면 다시 연결하세요. 이렇게 해서 자동 메일함이 서로 섞이지 않습니다. 처음에 연결되지 않은 런타임을 자기 세션에 연결하는 것은 계속 지원합니다.

### Codex 세션 연결

테스트한 Codex 0.159.3에서는 MCP 도구 호출마다 현재 thread가 `_meta.threadId`에 실려 옵니다.
- PeerLetter는 첫 등록 전(`peerletter_whoami` 포함)에 이 값을 검증합니다.
- 그래서 MCP 하위 프로세스에 `CODEX_THREAD_ID`가 없고 SessionStart 훅이 검토되지 않았어도 동작합니다.
- fork의 `_meta.sessionId`는 루트 세션을 가리킬 수 있어서 큐 대상으로 쓰지 않습니다.
- 이것은 버전에 따라 달라질 수 있는 연동으로, 설치된 클라이언트와 [Codex 도구 호출 소스](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)로 확인했습니다.

**`whoami.session_binding` 확인**
- `bound`는 호스트 세션이 확인된 상태입니다.
- `unbound`는 임시 `runtime:...` 메일함 신원만 있는 상태입니다. 기본 송수신은 되지만, 큐 깨우기에는 실제 thread ID가 필요합니다.
- 임시 ID는 호스트 세션 매핑에 기록되지 않습니다. 나중에 훅이 실행되면 그 매핑을 받아들일 수 있습니다.
- 임시 신원을 연결해도 정지 상태, 권고용 파일 점유, 깨우기 기준점은 유지됩니다.

**기본 thread 메타데이터를 보내지 않는 예전 클라이언트**
- 에이전트의 셸에서 **자기** `CODEX_THREAD_ID`를 읽은 뒤 `peerletter_bind_session({session_id: "<그 전체 UUID>"})`를 호출합니다.
- 또는 `/hooks`를 검토하고 새 세션을 시작해 SessionStart가 연결하게 합니다.
- 최근 rollout, 다른 참여자의 ID, 추측한 ID는 절대 쓰지 마세요.
- 기본 메타데이터로 thread가 이미 연결됐더라도 Stop과 Interrupt 훅은 여전히 호스트 검토가 필요합니다.
- 다른 신원 출처가 없는 예전 클라이언트에서 자동 이름을 되찾으려면, `peerletter_bind_session`을 첫 PeerLetter 호출로 쓰세요. 처음에 연결 없이 whoami를 부르면 새 메일함이 할당됩니다. 나중에 연결하면 그 메일함의 주소, 정지 상태, 파일 점유, 깨우기 기준점이 유지됩니다.

기존 Codex 대화를 이어가려면 처음부터 `codex resume <thread-id>`나 `codex resume --last`로 시작할 수 있습니다. 일반 공유 데몬 연결은, 큐 깨우기를 설정했더라도 PeerLetter 도구 호출이 있어야 이어받은 thread를 식별합니다.

설정한 이름이 이미 온라인이면, 도구가 조치 방법과 함께 `NAME_IN_USE`를 돌려줍니다. 소유자 연결이 끊긴 뒤 다시 시도하거나, 다른 세션이라면 다른 이름으로 재시작하세요. 등록 실패가 원인을 `NOT_READY` 뒤에 숨기거나 재시도를 영구히 막지는 않습니다.

**클라이언트 하나만 설치하기**
- `--client codex|claude|pi`를 붙입니다.
- 이름을 지정하려면 `--client codex --name codex-review`처럼 씁니다. 지정하지 않으면 살아 있는 세션이 `codex`, `codex-2` 등의 이름을 받습니다.
- 참여자마다 따로 이름을 정하려면 호스트를 실행할 때 `PEERLETTER_NAME`을 지정하세요. Codex 설정은 이 값을 MCP 하위 프로세스에 전달합니다.

### 설치 스크립트 대신 수동 등록

`node -p process.execPath`로 얻은 **Node 절대 경로**를 쓰세요. MCP 하위 프로세스에는 nvm의 PATH가 없을 수 있습니다.

```bash
NODE=/absolute/path/to/node
REPO=/absolute/path/to/PeerLetter
PROJECT=/absolute/path/to/project

claude mcp add -s local peerletter -- "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind claude
codex mcp add peerletter -- "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind codex
pi mcp add peerletter --local --exposure direct --cwd "$PROJECT" -- \
  "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind pi
```

- 위 명령은 프로젝트 디렉토리에서 실행하세요.
- Codex 명령은 그 프로젝트에 고정된 사용자 범위 서버를 등록합니다. 프로젝트 범위로 등록하려면 설치 스크립트를 쓰세요.
- 받은편지함을 직접 확인하는 방식에서는 훅 스크립트가 선택 사항입니다.

## 선택형 깨우기 장치

모든 알림에는 메일 개수와 받은편지함을 확인하라는 요청만 들어갑니다. **메일 본문은 절대 들어가지 않습니다.**
- 알림이 ACK하는 일은 없습니다.
- 성공한 알림은 메시지·세션·알림 경로별로 기록됩니다.
- 실패한 알림은 재시도할 수 있고 `whoami`·`peers`에 표시됩니다. 기본 receive는 계속 동작합니다.

### Claude monitor (권장)

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake monitor --apply
```

**프로젝트 로컬** 설치 스크립트는 MCP 서버, skill, 생명주기 훅, `experimental.monitors` 항목을 담은 비공개 로컬 Claude 플러그인을 생성합니다.
- 로컬 디렉토리 카탈로그를 등록하고 플러그인을 **local scope**로 설치합니다. 이 사용자의 이 프로젝트에서만 켜집니다.
- 아무것도 업로드하거나 배포하지 않습니다.
- 플러그인은 이 체크아웃에 설치된 의존성과 Node 절대 경로를 씁니다. 의존성은 계속 pnpm으로 관리하세요.
- 설치 스크립트는 Claude Code **2.1.283 이상**이 필요합니다.
- [매니페스트 레퍼런스](https://code.claude.com/docs/en/plugins-reference#monitors)와 [로컬 플러그인 설치](https://code.claude.com/docs/en/discover-plugins)를 참고하세요.

**적용하기**
- Claude를 평소처럼 재시작하세요. 첫 플러그인 설치는 기존 세션의 `/reload-plugins`로 검색할 수 있지만, 이미 실행 중인 MCP 런타임을 교체하려면 재시작해야 합니다. **channel 실행 플래그는 필요 없습니다.**
- 호스트의 일반적인 작업 공간·플러그인 신뢰 확인 창을 승인하세요. 설치 스크립트가 대신 승인하지 않습니다.
- 생성된 monitor는 세션 시작과 플러그인 다시 불러오기 때 감시를 시작합니다.
- Monitor 도구가 있는 대화형 세션에서만 동작합니다. `claude -p`에서는 동작하지 않으며, Bedrock, Google Cloud Agent Platform, Foundry 등 일부 클라우드 제공자에서는 쓸 수 없습니다.

**기존 설정 정리**
- 설치 스크립트는 이 체크아웃과 겹치는 프로젝트 `.mcp.json` 항목, 서버 승인 목록 항목, 훅 처리기, skill 링크를 제거합니다. 관계없는 설정은 그대로 두고, 바뀐 파일은 백업합니다.
- Claude의 플러그인 CLI는 사용자 설정(`extraKnownMarketplaces`)과 플러그인 레지스트리도 바꿉니다. 적용할 때 이 파일들의 기존 내용을 스냅샷으로 남기고, 파일이 원래 있었는지까지 포함해 `plugin_state_backups`로 출력합니다.
- 플러그인 MCP가 소유권을 가져가기 전에 이전 연결을 닫거나 다시 불러오세요.
- 따로 등록한 사용자 범위 PeerLetter MCP가 있다면 전환 전에 직접 지우세요. 두 번째 MCP는 이미 살아 있는 세션을 가져갈 수 없습니다.
- 플러그인 MCP 도구 이름에는 Claude 플러그인 네임스페이스가 붙을 수 있습니다. 호스트가 실제로 보여 주는 도구 이름을 쓰세요.

플러그인이 실행하는 명령은 다음과 같습니다.

```bash
node /path/to/PeerLetter/src/cli.ts --project /path/to/project watch
# 직접 관리하는 감시는 자기 세션과 이름을 정확히 지정할 수도 있습니다.
node /path/to/PeerLetter/src/cli.ts --project /path/to/project \
  --session <CLAUDE_SESSION_UUID> --name <EXACT_NAME> watch
```

**`watch` 동작**
- 자기 호스트의 현재 registry·세션 환경 변수 또는 명시적 UUID가 필요합니다. 설치된 2.1.287의 monitor는 현재 세션 ID를 내보내는 셸 실행기를 씁니다.
- 최근 세션을 찾거나 역할 이름을 추측하지 않습니다. ID가 없거나 유효하지 않으면 참여자를 만들지 않고 실패합니다.
- 자기 MCP가 아직 참여하지 않았으면 기다립니다. MCP 재연결과 같은 프로세스의 세션 전환에서도 검증된 자기 호스트를 따라갑니다.
- 하지 않는 일:
  - CLI 메일함 등록
  - MCP 온라인 상태 종료
  - MCP 파일 점유 해제
  - 메일을 읽음(delivered)으로 표시
  - ACK
- 이름이 맞지 않으면 거부합니다.
- 기본 깨우기 기준점은 이전 메일을 건너뜁니다. `--wake-backlog`를 주면 의도적으로 포함합니다.

**알림 기록과 종료**
- 알림이 성공할 때마다 stdout에 개수와 receive 안내 한 줄을 출력하고, `claude-monitor` 알림으로 기록합니다. 진단 메시지는 stderr로 보냅니다.
- SQLite가 프로젝트·세션마다 살아 있는 watch 프로세스를 하나로 보장합니다. 경쟁하는 watch는 거부하고, 비정상 종료 뒤에는 소유권을 회수합니다.
- 출력이 실패하면 재시도할 수 있습니다. 외부 출력과 기록 사이에 프로세스가 죽으면 알림이 반복될 수 있습니다. 정확히 한 번 전달은 보장하지 않습니다.
- `SIGINT`/`SIGTERM`, 호스트 종료, 다른 방식 선택은 MCP 연결을 끊지 않고 watch 소유권만 놓습니다. 실제 Claude ancestor가 확인된 기본 monitor는 SessionEnd → SessionStart 간격을 기다립니다. 명시적으로 세션을 고정한 watch는 세션 종료 때 끝납니다.
- `--timeout-ms MS`로 제한 시간을 둘 수 있습니다. monitor는 기본적으로 계속 감시합니다.

**재시작 뒤 확인**
- `whoami.wake_runner.online`과 `wake_error`를 확인하세요. MCP가 시작 시 등록됐다고 해서 monitor가 돌고 있거나 TUI가 반응한다는 증거는 아닙니다.
- 프로젝트 로컬 방식을 바꾸면 `.claude/peerletter.json`이 기록되고(전역 설치는 Claude 사용자 디렉토리 사용), 이전 monitor는 다시 불러오기 전이라도 이 파일을 읽고 곧바로 멈춥니다.
- Claude 플러그인을 비활성화하는 것만으로는 이미 감시 중인 monitor가 **멈추지 않습니다**. 설치 스크립트로 `none`을 고르거나, 그 작업을 직접 멈추세요. [monitor 생명주기](https://code.claude.com/docs/en/plugins/components#monitors)를 참고하세요.

### Claude `/resume`과 `/clear`

Claude는 MCP를 다시 띄우지 않고 현재 세션을 바꿀 수 있습니다. 상속된 `CLAUDE_CODE_SESSION_ID`는 이때 이전 값으로 남습니다. PeerLetter는 **자기 Claude ancestor**의 현재 registry 또는 그 살아 있는 호스트의 검증된 SessionStart 매핑을 따라갑니다. 다른 프로세스의 최근 세션을 고르지 않습니다. 계속 실행되는 monitor는 이전 감시 소유권을 놓고 실제 새 세션에 붙습니다. 호스트 신원을 확인할 수 없다면 다시 연결하세요.

이전 자동 참가자는 오프라인이 되고 자기 lease를 해제합니다. MCP는 새 세션이 PeerLetter를 사용한 적이 있을 때만(예: 이전에 참여한 세션의 `/resume`) 도구 호출 없이 그 세션에 참여하고, 그 세션의 자동 이름을 되찾습니다. `/clear`나 PeerLetter를 쓴 적 없는 대화로 바꾸면 MCP는 참여자 없이 기다립니다. 그 세션의 첫 PeerLetter 도구 호출은 다른 자동 메일함으로 참여하고, 나중에 사용한 세션으로 바꾸면 자동으로 다시 참여합니다. 메일과 수동 pause는 원래 세션에 남습니다. 명시적인 역할 이름은 의도한 비세션 지정 메일을 유지하며, `--session`은 고정되어 따라가지 않습니다. 살아 있는 소유자와 충돌하면 상대 참가자를 가져가거나 이전 actor의 lease를 해제하지 않고 실패합니다. watch 프로세스 자체는 MCP 온라인 상태나 lease를 바꾸지 않습니다.

체크아웃을 업데이트한 뒤 이미 로드된 MCP 코드는 **Claude 재시작**으로 교체해야 합니다. `/reload-plugins`는 플러그인 검색을 갱신하지만 기존 MCP를 다시 띄우거나 기존 monitor를 다시 시작한다고 보장하지 않으므로, 이번 런타임 수정 적용에는 충분하지 않습니다. 이전 MCP가 시작 시 세션 ID를 잡고 있다면 `claude --resume <SESSION_UUID>`로 직접 시작하는 것이 재연결 전까지의 우회 방법입니다. 전환 후 `whoami.session_id`, 정확한 이름, `wake_runner.online`, `wake_error`, `delivery_gate`를 확인하세요.

### Claude async-rewake (시간 제한이 있는 대안)

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake async-rewake --apply
```

이 로컬 플러그인은 `asyncRewake: true`인 백그라운드 Stop 훅을 씁니다.
- 턴이 끝날 때마다 같은 watch 핵심 로직으로 새 메일을 기다립니다.
- 실제 알림이 생기면 본문 없는 안내를 stderr에 쓰고, ACK 없이 알림을 기록한 뒤 **2**로 종료합니다. 이렇게 하면 Claude가 쉬는 상태에서 턴을 시작할 수 있습니다.
- 제한 시간 초과, 잘못된 입력, 기술적 실패로는 절대 2로 종료하지 않습니다.
- 대기 중인 훅이 이미 있으면 두 번째 감시를 시작하지 않고 정상 종료합니다.

**제한 시간과 공백**
- 호스트 제한 시간은 **600초**이고, 정리할 시간을 남기려고 대기는 **595초**에 끝납니다.
- 제한 시간이 지나면 **다음 Stop 이벤트까지 감시하지 않는 공백**이 생깁니다. 첫 턴이 끝나기 전에도 대기하는 훅이 없습니다.
- 제한 시간을 늘린다고 계속 감시하는 것과 같아지지는 않습니다. 세션 내내 깨우려면 monitor를 권장하는 이유입니다.
- 호스트의 제한 시간과 exit 2 동작은 [훅 레퍼런스](https://code.claude.com/docs/en/hooks)에 나와 있습니다.
- 공백 동안 `wake_runner.online`은 false이며, 직접 receive는 계속 쓸 수 있습니다.

### Claude 게이트와 방식 변경

모든 Claude 장치는 저장된 수동 정지와, 보고된 UI·compaction·세션 종료 게이트를 따릅니다.

| 훅 | 게이트에 주는 영향 |
|---|---|
| PermissionRequest | 해당 도구 호출의 게이트를 엶 |
| PostToolUse / PostToolUseFailure | 그 호출의 게이트를 닫음 |
| Elicitation / ElicitationResult | 해당 게이트를 보고 |
| PreCompact / PostCompact | 해당 게이트를 보고 |
| SessionEnd | 감시를 멈춤 |
| StopFailure | 제공자 오류 뒤 정지 |
| UserPromptSubmit (명시적 입력) | 수동 정지를 풂 |
| PostToolUseFailure `is_interrupt:true` | 정지 (값이 있을 때) |

**Claude가 모든 취소와 UI를 훅으로 알려 주지는 않습니다.**
- 모든 Escape·취소나 모든 UI 대화상자에 대한 믿을 만한 훅이 없습니다. 실행 중인 도구를 취소해도 PostToolUseFailure가 실행되지 않을 수 있습니다.
- 장치는 보고되지 않은 호스트 정지를 추측하지 못합니다. `peerletter --name <EXACT_NAME> pause`로 모든 장치가 따르는 정지를 저장하고, `resume`이나 새 사용자 입력으로 풀어 주세요.
- 게이트는 생명주기 훅이 불러와지고 신뢰된 경우에만 동작합니다. 대기 시간, 메일 중요도, 오류 문구로 게이트를 추측하지 않습니다.

**방식 고르기**

Claude 방식은 `--client claude --wake monitor|async-rewake|channel|none` 중 정확히 하나를 고릅니다. 전체 이름인 `claude-*` 값도 됩니다. 예:

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake none --apply
```

- none이나 channel을 고르면 이 프로젝트에서 생성한 플러그인 항목을 끄고, 파일 MCP·skill·훅 설정을 복원합니다.
- 방식을 바꾼 뒤에는 호스트 연결을 다시 불러오세요.
- 기존 받은편지함, ACK, 정지 상태는 유지됩니다.
- 파일 변경을 되돌리려면 출력된 설정 백업을 복원하세요. 카탈로그는 로컬에 남으며, Claude 플러그인 명령으로 따로 지울 수 있습니다.

### Claude channel

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake claude-channel --apply
cd /path/to/project
claude --dangerously-load-development-channels server:peerletter
```

실험 기능인 `claude/channel` capability와 `notifications/claude/channel`을 사용합니다.
- 이 로컬 서버는 공개 마켓플레이스 플러그인이 아니어서 개발용 플래그가 필요합니다.
- 계정과 버전별 지원 여부는 [channels 공식 문서](https://code.claude.com/docs/en/channels-reference)에서 확인하세요.
- 이 방식에서는 channel과 경쟁하지 않도록 작업 중 메일 알림을 끕니다. 수동 Stop/PostToolUse 알림을 쓰려면 none으로 바꾸세요.

재시작한 MCP가 PeerLetter를 사용한 세션의 `CLAUDE_CODE_SESSION_ID`를 물려받으면, 첫 whoami 호출 없이 등록하고 감시합니다. 새 세션이거나 초기화 때 실제 세션을 식별할 수 없으면 whoami를 한 번 호출해 참여하세요. `--wake` 플래그를 저장해 두는 것만으로는 Claude 호스트의 channel 활성화를 건너뛸 수 없습니다.

### Codex queue

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client codex --wake codex-queue --apply
```

이 장치는 호스트에 이미 떠 있는 로컬 앱서버 데몬에 Unix WebSocket 제어 소켓으로 붙습니다.
- `thread/read`로 자기 thread를 확인한 뒤, 실험 메서드 `thread/queue/add|list|delete`를 씁니다. 이 부분은 **버전에 따라 달라질 수 있으며**, Codex 0.160.0으로 확인했습니다.
- PeerLetter는 데몬을 시작하지 않고, thread를 이어받거나 다른 thread를 구독하지 않습니다.
- 자기 thread ID는 기본 도구 호출 메타데이터, 명시적 자기 연결, `CODEX_THREAD_ID`, SessionStart 훅의 PID 매핑에서 얻고, 호스트 프로세스를 확인합니다.
- 쓸 수 있는 UUID·데몬·호환 API가 없으면 `wake_error`를 보고하고 재시도합니다.
- 큐 장치가 오류를 보고한 동안에는 승인된 Stop 훅이 대신 알리고, 직접 receive도 계속 쓸 수 있습니다.
- 설치하거나 업데이트한 뒤에는 `/hooks`를 검토하고, MCP를 재시작하거나 다시 연결한 다음 whoami를 호출하세요.

**쉬고 있는(`idle`) thread에만 새 큐 항목을 넣습니다.**
- 진행 중인 턴(승인이나 사용자 입력을 기다리는 경우 포함)이면 알림을 미룹니다. 수신 기록을 남기지 않고, 바쁜 상태를 오류로 보고하지도 않습니다.
- 쉬는 상태가 되면 메일 전달 여부와 정지·게이트를 다시 확인합니다.
- 그래서 진행 중인 턴 안에서 받은 메일 때문에 나중에 큐 턴이 생기지 않습니다.

**소켓 경로**
- 기본 소켓은 `$CODEX_HOME/app-server-control/app-server-control.sock`입니다. `CODEX_HOME`이 없으면 `~/.codex/...`입니다.
- `PEERLETTER_CODEX_SOCKET`으로 다른 로컬 소켓의 절대 경로를 지정할 수 있습니다.
- 공개 경로와 실제 소켓 모두 현재 사용자 소유여야 합니다. Codex 자체의 소켓 심볼릭 링크는 지원합니다.
- 원격 WebSocket 데몬은 이 장치에서 다루지 않습니다.

**대기 알림 관리 (`codex_wakes` 테이블)**
- 추가 테이블 `codex_wakes`에 thread마다 PeerLetter가 소유한 대기 제출 하나를 저장합니다. 고유 클라이언트 메시지 ID, 큐 ID, 메일 묶음도 함께 저장합니다.
- 대기 항목이 있는 동안 뒤이어 온 메일은 큐 항목을 더 만들지 않습니다. 그 메일은 receive나 다음 깨우기에서 받을 수 있습니다.
- receive·ACK는 결과를 돌려주기 전에 저장된 항목을 정리합니다. watch도 받은편지함이 비어 있을 때 정리합니다.
- 묶음이 전달됐거나 게이트가 세션을 정지시키면, 변하지 않은 PeerLetter 큐 항목만 지웁니다.
- 사용자 큐 항목, 수정된 제출, 소유 ID가 저장되지 않은 이전 항목은 지우지 않습니다.
- 자동 큐 방식이 정상일 때는 Stop 훅이 watch에 양보합니다. 이미 확보된 묶음에는 경쟁하는 훅 알림이 붙지 않습니다.

**남는 한계**
- 상태 확인·큐 추가·전달은 SQLite와 앱서버에 걸쳐 있어서 원자적으로 처리할 수 없습니다.
- 이미 턴으로 소비된 제출은 회수할 수 없습니다. 그 사이에 프로세스가 죽거나 응답이 유실되면 추가 턴이 생길 수 있습니다.
- 대기 중인 추가 의도는 정확한 클라이언트 메시지 ID로 복구합니다. 삭제에 실패하면 재시도를 위해 소유권을 유지합니다.
- 알림 문구에는 받은편지함이 이미 비어 있고 진행 중인 작업도 없으면 바로 끝내라는 안내가 들어 있습니다. 받은편지함이 비었다는 이유로 진행 중인 작업을 멈추지는 않습니다.
- 전달은 최소 한 번(at-least-once)을 유지합니다.

**Interrupt 훅과 정지**
- Interrupt 훅은 사용자 정지를 기록합니다. 정지 중에는 높은 중요도의 메일도 큐 깨우기를 하지 않습니다.
- 새 명시적 사용자 입력이나 CLI `resume`으로 풀립니다.
- 이 보호는 훅이 실행될 때만 동작합니다. 검토되지 않았거나 꺼진 Interrupt 훅은 호스트의 정지 상태를 알려 줄 수 없습니다.

**시작 시 등록**
- 큐의 시작 시 등록은 PeerLetter를 사용한 thread를 `--session <실제 thread UUID>`로 고정한 연결에서만 됩니다.
- 공유 데몬의 PID 매핑과 물려받은 환경 변수 ID는 SessionStart 훅을 승인한 뒤에도 충분하지 않습니다.
- 일반 설치 설정에서는 재시작한 뒤 whoami를 한 번 호출하세요. 첫 도구 요청이 실제 thread를 알려 줍니다.
- 재시작만으로는 식별되지 않은 Codex thread의 자동 깨우기를 보장할 수 없습니다.

### Pi 확장

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client pi --pi-mode extension --apply
```

Pi를 다시 불러오거나 새 세션을 시작하세요.
- 확장은 같은 stdio MCP 핵심을 동적으로 등록하고, 실제 Pi 세션 ID를 연결합니다.
- 설치 스크립트는 자기 파일 MCP 항목을 제거해, 그 항목이 이 등록을 덮어쓰지 못하게 합니다.
- 확장을 쓸 때는 전역 `mcp.json`에 `peerletter`라는 항목을 남기지 마세요. Pi는 파일 설정을 우선합니다.
- 대신 `pi -e ~/dev/PeerLetter/pi/peerletter.ts --skill ~/dev/PeerLetter/skills/peerletter`로 실행할 수도 있습니다.

**파일 MCP 방식과의 차이**
- 기본 파일 MCP 방식은 Pi 세션 ID가 없고 `/new`를 감지하지 못합니다. whoami에 `unbound`로 나옵니다. 실제 세션 신원과 세션 전환을 쓰려면 확장 방식을 쓰세요.
- `/new`, resume, fork, reload, 종료 때 확장은 자기 참여자만 닫고, 파일 점유를 풀고, 감시를 멈춥니다.
- 다음 세션이 PeerLetter를 사용한 적이 있으면(resume, reload) 그 MCP는 초기화 때 참여하고, 확장은 첫 도구 호출 없이도 알릴 수 있습니다. `/new` 세션은 첫 PeerLetter 도구 호출까지 기다립니다. 확장은 참여자를 따로 할당하지 않고, 내부에서 whoami를 호출하지도 않습니다.
- 같은 실제 세션을 이어받으면 오프라인 자동 이름을 다시 쓰고, `/new`는 다른 자동 이름을 받습니다. 명시적으로 정한 역할 이름은 보존된 받은편지함을 이어갑니다.
- 같은 세션을 다른 Pi 프로세스에서 불러와도, 첫 프로세스의 참여자 소유권을 가져가지 못합니다.

**알림 방식**
- 확장은 받은편지함을 감시하다가 본문 없는 `pi.sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`를 보냅니다.
- 수동 정지, 중단, 제공자 오류, UI 대화상자, compaction 중에는 주입을 막습니다.
- `/peerletter pause`, `/peerletter resume`, `/peerletter status`로 제어하거나 확인합니다. 새 명시적 사용자 입력은 정지를 풉니다.
- 설치된 Pi 0.99.2의 확장 API를 대상으로 합니다. [Pi 확장 문서](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)를 참고하세요.

### 재시작과 이전 메일

메시지는 이름별 받은편지함에 남습니다.
- 같은 세션은 다시 연결할 때 자기 자동 메일함을 되찾고, 다른 세션은 별도의 자동 메일함을 받습니다.
- `to_session`을 생략하면 명시적 역할 이름은 의도적으로 세션을 넘어 메일을 유지합니다. 세션을 지정한 메시지는 그 세션에 묶여 있습니다.
- 새 세션에서 깨우기 장치는 이전에 저장된 메일을 건너뜁니다. 확인하려면 직접 receive를 호출하세요.
- 쌓인 메일로도 깨우게 하려면 stdio에 `--wake-backlog`를 주거나, Pi 확장에 `PEERLETTER_WAKE_BACKLOG=1`을 지정하세요.
- Stop 훅은 세션 등록 전에 온 메일을 건너뜁니다.

## 도구와 전달

| 도구 | 용도 |
|---|---|
| `peerletter_whoami`, `peerletter_peers` | 이름, 세션, 작업 공간, 온라인 여부, 깨우기 상태, 이름 정책, 세션 연결 |
| `peerletter_bind_session` | 기본 메타데이터가 없는 Codex 클라이언트의 복구용. 이 참여자를 자기 현재 thread의 전체 UUID에만 연결 |
| `peerletter_send` | `to`, `text`, 필수 `idempotency_key`. 선택: 전체 UUID `reply_to`, `thread_id`, `to_session`, `importance` |
| `peerletter_receive`, `peerletter_peek` | 미확인 메시지 최대 20건. 중요도, 그다음 접수 순서. 선택형 커서 |
| `peerletter_ack` | 수신자가 처리 후 원자적으로 일괄 확인 |
| `peerletter_status` | 접수·알림·전달·확인 시각과 답장 ID |
| `peerletter_lease_claim`, `peerletter_lease_release`, `peerletter_lease_list` | TTL과 갱신이 있는 프로젝트 기준 상대 경로의 권고용 파일 점유 |

**전달과 확인**
- `receive(wait_ms)`는 0–30000을 받고, 돌려준 메일을 ACK 없이 전달(delivered)로 표시합니다. `peek`는 전달 상태를 바꾸지 않습니다.
- 비정상 종료 뒤에는 읽기와 알림이 반복될 수 있습니다. 외부 작업이 정확히 한 번 실행된다는 보장은 없습니다. 중복 제거가 필요한 후속 처리에는 메시지 ID를 보관하세요.
- ACK는 처리했다는 뜻이고, 완료를 알리려면 명시적인 결과나 답장이 필요합니다.

**이름과 온라인 여부**
- 이름은 온라인 참여자 사이에서 유일합니다.
- 명시적 이름 충돌은 `NAME_IN_USE`로 실패합니다. 자동 이름은 아직 쓰이지 않은 접미사를 쓰거나, 같은 오프라인 세션의 이름을 되찾습니다.
- 같은 호스트 세션이 두 번 살아 있으면 `SESSION_IN_USE`로 실패합니다.
- 온라인 여부는 하트비트 시간 초과가 아니라 MCP PID와 프로세스 시작 시각으로 판단합니다.
  - EOF·SIGTERM이면 오프라인으로 표시하고 파일 점유를 풉니다.
  - SIGKILL은 다음 온라인 점검 때 감지하고, 비정상 종료된 프로세스의 점유는 TTL로 만료됩니다.
  - 등록되어 살아 있는 프로세스는 쉬고 있어도 온라인입니다.

## SQLite와 유지 관리

- **작업 공간 키:** 실제 Git 루트의 SHA-256입니다. Git 밖이면 실제 cwd를 씁니다. 한 체크아웃의 하위 디렉토리는 같은 메일함을 공유하고, 다른 worktree는 경로와 메일함이 따로입니다.
- **기본 DB 위치:** `~/.local/state/peerletter/<key>/peerletter.db`이며, 그 작업 공간에서 PeerLetter를 처음 사용할 때 만들어집니다. `PEERLETTER_STATE_DIR`은 상태 루트를, `PEERLETTER_PROJECT`는 작업 공간을 바꿉니다.
- **권한과 신뢰 경계:**
  - 디렉토리는 0700, DB·WAL·SHM 파일은 0600입니다.
  - 로컬 OS 계정이 신뢰 경계입니다. CLI는 로컬의 어떤 이름 메일함으로도 행동할 수 있으며, 다른 사용자 간 인증이 아닙니다.
- **SQLite 설정:**
  - WAL, 5000ms busy timeout, 외래 키, `synchronous=FULL`을 씁니다.
  - 대기(long poll) 중에는 쓰기 트랜잭션을 잡지 않습니다.
  - 로컬 저장소를 쓰세요. WAL은 네트워크 파일시스템에 맞지 않습니다.
- **스키마 2:**
  - 별도 테이블에 이름 정책과 세션 출처 메타데이터를 추가합니다.
  - 기존 스키마 1의 메일함, 메시지, 전달 상태, 파일 점유는 원자적 이전으로 보존됩니다.
  - `legacy` 이름은 같은 세션이 되찾을 수 있고, 다른 자동 세션에게는 예약된 상태로 남습니다.
  - 예전 체크아웃은 이전된 DB를 열 수 없으니, 모든 클라이언트를 이 체크아웃으로 업데이트하고 다시 연결하세요.
- **추가 테이블:**
  - `watch_owners`는 Claude watch 프로세스를 조율합니다. 참여자·세션 신원을 대체하거나, 받은편지함을 만료시키거나, 전달·ACK 기록을 바꾸지 않습니다.
  - `used_sessions`는 PeerLetter 도구를 호출한 호스트 세션을 기록하며, 이 세션만 자동으로 참여합니다. 이전 체크아웃의 DB에는 아직 기록이 없으므로, 업데이트한 뒤 세션마다 whoami를 한 번 호출하세요.
  - `codex_wakes`는 대기 중인 Codex 큐 알림의 소유권을 보존합니다. 아직 대기 중인 알림을 취소하면 그 미확인 메일이 다른 알림의 대상이 될 수 있습니다. 수신과 ACK 상태는 보존됩니다.
- **보관:** 수동으로 정리합니다. `prune --days 30`은 모든 메시지가 ACK됐고 ACK가 30일보다 오래된 스레드 전체의 삭제 대상을 미리 보여 주고, `--apply`로 삭제합니다. 자동 삭제는 없습니다.
- **점검:** `doctor`는 권한과 SQLite 무결성을 확인합니다. `doctor --checkpoint`는 TRUNCATE checkpoint를 요청하니, 사용량이 적을 때 실행하고 busy 결과를 확인하세요.

**파일 점유**
- `*`, `**`, `?`만 받습니다. 원자적으로 얻고 갱신하며, 소유자의 세션에 속합니다.
- 와일드카드가 겹치는지는 보수적인 접두사로 판단해서, 충돌을 실제보다 많이 보고할 수 있습니다.
- 다른 도구의 편집을 강제로 막지는 않습니다. Git 상태 변경은 따로 조율하세요.

받은편지함 확인 시점, ACK 규칙, 파일 조율, 답장 반복 제한은 공용 [협업 skill](skills/peerletter/SKILL.md)을 읽으세요. 메일 내용은 새 작업을 허가하거나 사용자 지시를 대신할 수 없습니다.

## 테스트와 GitHub 워크플로

**기본 테스트**
- `pnpm run check`는 핵심, 훅, 스크립트, Pi 확장의 타입을 검사합니다.
- `pnpm test`는 공유 SQLite 동작을 검사하고, 실제 SDK stdio 클라이언트를 Codex·Claude·Pi로 띄워 봅니다. 테스트는 임시 상태를 쓰며 실제 에이전트 메일함을 쓰지 않습니다.
- GitHub Actions 워크플로는 깨끗한 체크아웃에서 Node 24로 실행합니다. 고정된 pnpm lockfile을 설치하고, 타입을 검사하고, 테스트를 돌립니다. 배포 단계는 없습니다.

**검증 범위**
- **기본 동작:** 동시 쓰기, 중복 제거, 답장 방향, 중요도 커서, 원자적 ACK 소유권, 취소, 파일 점유, 재시작 후 보존, SIGKILL 감지, 권한, 알림 게이트, Claude channel 형식.
- **등록과 이름:**
  - 모든 클라이언트의 수동 지연 등록, 조건부 시작 시 등록
  - PeerLetter를 사용한 적 없는 깨우기 세션이 DB를 만들지 않고 참여하지 않는지
  - 사용하지 않은 작업 공간에 훅·watch·Pi 확장이 상태를 남기지 않는지, 범위를 제한한 안내문과 도구 annotation
  - 수신자가 도구를 호출하기 전의 Claude·Pi 깨우기
  - 모호한 공유 PID 훅 매핑, 첫 호출로 정하는 Codex 신원
  - 같은 세션의 이름 되찾기, 메일 격리, 스키마 1 이전, 살아 있는 소유자 보호
  - 실제 stdio MCP 클라이언트로 한 Pi `/new`·resume, 명시적 복구, 등록 재시도, Claude 턴 도중 훅
- **Codex 큐:**
  - 로컬 Unix WebSocket 픽스처를 쓴 큐 장치
  - 바쁠 때와 읽었을 때의 보류, 대기 묶음 하나, 전달·추가와 정지의 경쟁, 훅 경쟁
  - 응답 유실, 소유권 복구, 삭제 실패, 바뀐 입력, 소켓 심볼릭 링크, 재연결
- 테스트는 실제 에이전트에게 메일을 보내지 않습니다.

**watch 픽스처**
- watch 다음에 시작하는 실제 SDK MCP, 도구 호출 없는 시작, 같은 세션 재연결, 정확한 이름 확인, 참여자·점유 보존을 다룹니다.
- 살아 있는 watch 하나, 죽은 소유자 회수, 이전에 쌓인 메일, 정지·UI·compact, 출력 실패, 방식 변경, 작업 중 알림 장치와의 배타성, ACK 없는 async-rewake 종료 코드도 다룹니다.
- 이 픽스처는 장치를 검증할 뿐, 호스트의 실제 대화형 UI 동작을 검증하지는 않습니다.
- 생성된 플러그인과 카탈로그 매니페스트는 `claude plugin validate --strict`로 검증하고, 실제 대화형 클라이언트에서 channel 플래그 없이 쉬는 상태 깨우기를 확인하세요.

**설치된 클라이언트 테스트 (선택)**

| 명령 | 필요한 것 | 확인하는 것 |
|---|---|---|
| `pnpm run test:native-codex` | 설치된 Codex | 격리 설정에서 실제 `codex exec`를 가짜 Responses 제공자로 실행하고, MCP 환경에서 `CODEX_THREAD_ID`를 뺀 상태로 기본 메타데이터가 Codex가 내보내는 것과 같은 thread ID로 연결되는지 |
| `pnpm run test:native-codex-queue` | 설치된 Codex, Python 3, Unix PTY | 격리된 앱서버와 실제 대화형 TUI를 가짜 Responses 제공자로 띄워, 바쁜 턴에서 받고 ACK한 여러 메일은 추가 턴 0건, 읽지 않은 메일은 턴이 끝난 뒤 1회, 쉬는 상태 메일은 1회 깨우는지 |
| `pnpm run test:native-pi` | 설치된 Pi 0.99.2 SDK·CLI | 격리된 전역 설치·RPC·가짜 chat 제공자로 프로젝트 신뢰 없이, 새 세션이 첫 도구 호출 전에는 참여하지 않고 이후 idle 메일 깨우기 1회 |
| `pnpm run test:native-global-setup` | 설치된 Claude Code, pnpm 다운로드를 위한 네트워크 | 빈 HOME·의존성 없는 임시 체크아웃에서 실제 `setup all`, 사용자 플러그인 범위·SQLite·읽기 쉬운 보고서 확인, 로컬 bare remote에서 `setup update`로 갱신한 뒤 전체 삭제 |
| `pnpm run test:native-claude` | 설치된 Claude Code, Python 3, Unix PTY | 임시 프로젝트에 **async-rewake**를 설치하고 "사용함"으로 기록한 세션을 띄워, 도구 호출 없이 참여하고 메일만으로 본문 없는 알림이 담긴 다음 대화형 모델 턴이 시작되는지 |

- **공통:**
  - 가짜 응답 서버(loopback)만 쓰고 외부 모델을 호출하지 않습니다.
  - 실제 데몬, 메일함, 설정, 받은편지함을 바꾸지 않습니다.
- **`test:native-codex`:** 설치된 클라이언트의 신원만 확인하는 별도 테스트입니다. 쉬고 있는 TUI가 깨어난다는 증거는 아닙니다.
- **`test:native-codex-queue`:** `pnpm run test:native-codex-queue -- --global`은 프로젝트 고정 MCP 없이 전역 설치를 검증하며 CI도 이 모드를 사용합니다. 생성된 픽스처에 대해서만 일반 UI 신뢰 확인을 승인합니다. Codex 0.160.0으로 테스트했고, 가짜 응답으로 실제 호스트와 장치의 동작을 검증합니다.
- **GitHub Actions:** Codex 0.160.0을 pnpm으로 임시 설치해 두 Codex 테스트를 모두 실행합니다.
- **`test:native-claude`:**
  - 격리된 Claude 설정과 PeerLetter 상태를 쓰고, 생성된 픽스처에 대해서만 일반 UI 확인을 승인합니다.
  - 가짜 API 키로 로컬 가짜 Anthropic 제공자에 연결하며, channel 플래그를 쓰지 않습니다. 픽스처는 ACK하지 않습니다.
  - 초기 설정 화면 자동화는 버전에 따라 달라질 수 있으며, Claude Code 2.1.287로 테스트했습니다.
  - 이 클라이언트의 로컬 API 키 구성에서는 Monitor를 쓸 수 없어서, monitor 경로는 Monitor를 지원하는 대화형 계정·제공자에서 따로 확인해야 합니다.
  - `pnpm run test:native-claude -- --session-transitions`는 실제 `/clear`·`/resume <UUID>` UI 명령을 입력하고, `/clear` 뒤 사용하지 않은 세션에 참여하지 않고 떠나는지, resume 때 MCP를 다시 띄우지 않고 실제 세션·이름이 복구되는지와 이후 async-rewake의 idle 깨우기를 확인합니다. Monitor가 없는 제공자에서 Monitor까지 검증하지는 않습니다.
  - 기본 CI SDK 테스트와는 별개인 선택 테스트입니다.

**전역 설치·세션 전환 테스트**

`test:native-pi`는 실제 Pi 0.99.2 CLI를 RPC 모드로 시작합니다. 격리된 사용자 전역 설치, 로컬 가짜 제공자, 신뢰하지 않은 프로젝트 리소스를 사용하며, 새 세션이 첫 PeerLetter 도구 호출 전에는 참여하지 않는지와 메일 본문·ACK 없는 idle 깨우기 1회를 확인합니다. 외부 모델을 호출하지 않으며 CI에서도 실행합니다.

임시 HOME에서 세 호스트 설치, 다른 설정과 이후 변경 보존, 다른 설정·수정된 관리 블록 거부, 프로젝트 신뢰 없이 실제 Pi 사용자 확장·skill 로드, 호출한 Codex thread의 Git 루트 선택을 검증합니다. Claude 전환 픽스처는 실제 ancestor 프로세스·MCP·watch를 실행하고 문서화된 registry·훅 변경을 재현합니다. `/clear`·`/resume`, 이전 환경 변수, 도구 재호출 없이 등록, 사용하지 않은 세션에서 떠나기와 사용한 세션에 다시 참여, 자동 이름 복구, pause·메일·lease 격리, 명시 세션 고정, 실패 시 rollback을 확인합니다. 모든 호스트·제공자가 Monitor를 제공한다는 증거는 아닙니다.

`test:native-global-setup`은 현재 소스를 의존성 없는 임시 체크아웃에 복사하고 빈 HOME에서 실제 `setup all`과 일반 사용자 플러그인 CLI를 실행합니다. 설정 범위·SQLite·읽기 쉬운 보고서·반복 설치를 확인하고, 로컬 bare remote에서 `setup update`로 체크아웃을 fast-forward해 갱신된 skill 사본을 확인한 뒤 `setup --uninstall all`을 실행합니다. 외부 모델을 호출하거나 실제 사용자 설정을 바꾸지 않습니다.

## 업데이트

`setup update`로 업데이트한 뒤([업데이트](#업데이트) 참고) 클라이언트를 다시 연결하거나 재시작하세요. Claude MCP 런타임 코드가 바뀌었다면 Claude를 재시작하세요. 버전 올리기, 레지스트리 업로드, 마켓플레이스 배포는 필요 없습니다.
