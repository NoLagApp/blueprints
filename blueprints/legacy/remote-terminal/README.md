# Remote Terminal

A terminal app that uses NoLag to remotely control computers. Built with Go and [Bubbletea](https://github.com/charmbracelet/bubbletea) for the TUI.

## Prerequisites

1. A NoLag account at [nolag.app](https://nolag.app)
2. Go 1.21+ installed

## NoLag Setup

Before running the app, you need to set up NoLag:

### 1. Create a Project

1. Log in to [NoLag Dashboard](https://app.nolag.app)
2. Create a new **Project**
3. Note your **Project ID**

### 2. Create Actors (Tokens)

You need actor tokens for each client/agent. Create actors via the dashboard or API:

**For the Agent (device being controlled):**
- Create an actor with type `device`
- Name it something like `my-pc-agent`
- Copy the **Actor Token** (`at_xxx...`)

**For the Client (controller):**
- Create an actor with type `user` or `session`
- Name it something like `controller`
- Copy the **Actor Token** (`at_xxx...`)

> You can use the same token for both agent and client during testing, but in production you should use separate tokens with appropriate permissions.

### 3. Create App and Topics

Topics must be defined in your App schema. Create the following:

**App Name:** `remote-terminal`

**Topics to create:**

| Topic Name | Direction | Purpose |
|------------|-----------|---------|
| `commands` | Client → Agent | Shell commands, file transfers, pings |
| `responses` | Agent → Client | Command output, errors, file data |
| `status` | Agent → Client | Device info, working directory, online status |
| `discovery` | Agent → All | Device announcements for `!devices` list |

> **Note:** Rooms (like `{device-id}`) are created dynamically, but the topics above must exist in your App schema.

**Topic structure at runtime:**

```
App: remote-terminal

Per-device rooms (dynamic):
├── remote-terminal/{device-id}/commands
├── remote-terminal/{device-id}/responses
└── remote-terminal/{device-id}/status

Discovery room:
└── remote-terminal/_discovery/discovery
```

### 4. Message Format

Commands sent from client to agent:
```json
{
  "id": "abc123",
  "type": "shell|ping|info|upload|download|complete|listdir",
  "payload": "command or path",
  "data": "base64 encoded file data (for uploads)",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

Responses sent from agent to client:
```json
{
  "commandId": "abc123",
  "status": "success|error",
  "output": "command output",
  "error": "error message if failed",
  "exitCode": 0,
  "data": "base64 encoded file data (for downloads)",
  "completions": ["file1", "file2"]
}
```

## Building

```bash
cd blueprint/remote-terminal
go mod tidy
go build -o bin/agent.exe ./cmd/agent
go build -o bin/client.exe ./cmd/client
```

## Quick Start

### 1. Start the Agent (on the machine you want to control)

```bash
./bin/agent -token "at_YOUR_TOKEN" -apikey "nlg_live_xxx.secret" -appid "YOUR_APP_ID" -device "my-pc"
```

Options:
- `-token` (required): Your NoLag actor token
- `-apikey` (required): Your NoLag API key (for dynamic room creation)
- `-appid` (required): Your NoLag App ID
- `-device`: Device ID (defaults to hostname)
- `-broker`: Custom broker URL (default: `wss://broker.nolag.app/ws`)
- `-api`: Custom API URL (default: `https://api.nolag.app/v1`)
- `-debug`: Enable debug logging

The agent will automatically create a room for the device on startup (topics are inherited from the App).

### 2. Start the Client (on your control machine)

```bash
./bin/client -token "at_YOUR_TOKEN_HERE" -device "my-pc"
```

Or start without a device and connect later:

```bash
./bin/client -token "at_YOUR_TOKEN_HERE"
```

Then use `!connect my-pc` to connect.

Options:
- `-token` (required): Your NoLag actor token
- `-device`: Device ID to connect to (optional)
- `-broker`: Custom broker URL
- `-debug`: Enable debug logging

## Commands

### Connection
| Command | Description |
|---------|-------------|
| `!devices` | List all discovered devices |
| `!connect <id>` | Connect to a device |

### Remote Execution
| Command | Description |
|---------|-------------|
| `!ping` | Ping the device |
| `!info` | Get system info |
| `!ls [path]` | List directory contents |
| `<command>` | Execute shell command |
| `cd <path>` | Change remote working directory |

### File Transfer
| Command | Description |
|---------|-------------|
| `!download <remote> [local]` | Download file from device |
| `!upload <local> <remote>` | Upload file to device |

### Local
| Command | Description |
|---------|-------------|
| `!help` | Show help |
| `!clear` | Clear output |
| `!quit` | Exit |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Execute command / Apply completion |
| `↑` / `↓` | Navigate command history |
| `Tab` | Auto-complete commands and paths |
| `PgUp` / `PgDn` | Scroll output |
| `Esc` / `Ctrl+C` | Quit |

## Example Session

```
Remote Terminal  ● my-pc | C:\Users\henco (windows)
╭──────────────────────────────────────────────────────────────╮
│ ✓ Connected to NoLag broker                                  │
│   Connected to device: my-pc                                 │
│                                                              │
│ $ whoami                                                     │
│ henco                                                        │
│                                                              │
│ $ dir                                                        │
│  Volume in drive C is Windows                                │
│  Directory of C:\Users\henco                                 │
│ ...                                                          │
│                                                              │
│ $ !download config.json                                      │
│ ✓ Downloaded 1234 bytes to config.json                       │
╰──────────────────────────────────────────────────────────────╯

my-pc> _

  ctrl+c: quit • ↑↓: history • tab: complete • pgup/pgdn: scroll
```

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Client    │ ──────► │  NoLag      │ ◄────── │   Agent     │
│  (control)  │         │  Broker     │         │  (target)   │
└─────────────┘         └─────────────┘         └─────────────┘
     │                        │                       │
     │  !connect my-pc        │                       │
     │ ──────────────────────►│                       │
     │                        │  Subscribe to         │
     │                        │  remote-terminal/     │
     │                        │  my-pc/commands       │
     │                        │◄──────────────────────│
     │  "whoami"              │                       │
     │ ──────────────────────►│ ─────────────────────►│
     │                        │                       │ Execute
     │                        │                       │ command
     │                        │◄──────────────────────│
     │◄───────────────────────│  Response: "henco"    │
     │                        │                       │
```

## Troubleshooting

### Client opens and closes immediately

Make sure you're passing the `-token` flag:
```bash
./bin/client -token "at_YOUR_TOKEN_HERE"
```

If running from Windows Explorer, open a terminal first (cmd/PowerShell) and run from there.

### Connection issues

1. Check your token is valid
2. Ensure the agent is running on the target machine
3. Use `-debug` flag to see connection logs:
   ```bash
   ./bin/client -token "at_xxx" -debug
   ```

### Device not showing in !devices

Devices broadcast their status every 30 seconds. Wait a moment or run `!ping` if already connected.

## Limitations

- File transfer max size: 10MB
- No encryption (relies on NoLag's transport security)
- Commands run synchronously (no background jobs yet)
