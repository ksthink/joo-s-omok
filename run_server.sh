#!/bin/bash
# Omok Game Server Manager with Auto-Restart
# Prevents duplicate instances and auto-recovers from crashes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
ERROR_LOG="$LOG_DIR/server_error.log"
PID_FILE="$SCRIPT_DIR/server.pid"
LOCK_FILE="$SCRIPT_DIR/server.lock"
WATCHDOG_PID="$SCRIPT_DIR/watchdog.pid"

# Create directories
mkdir -p "$LOG_DIR"

# Settings
MAX_RESTART=10
RESTART_DELAY=3
HEALTH_CHECK_INTERVAL=10

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

error_log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] ERROR: $1" >> "$ERROR_LOG"
    log "${RED}ERROR: $1${NC}"
}

# Acquire lock to prevent multiple instances
acquire_lock() {
    if [ -f "$LOCK_FILE" ]; then
        local lock_pid=$(cat "$LOCK_FILE")
        if kill -0 "$lock_pid" 2>/dev/null; then
            echo "${RED}Another instance is already running (PID: $lock_pid)${NC}"
            return 1
        else
            log "${YELLOW}Removing stale lock file${NC}"
            rm -f "$LOCK_FILE"
        fi
    fi
    
    echo $$ > "$LOCK_FILE"
    return 0
}

release_lock() {
    rm -f "$LOCK_FILE"
}

# Check if server process is running
is_server_running() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Check if server is responding
is_server_responding() {
    local port=${1:-8081}
    if curl -s --connect-timeout 2 "http://localhost:$port/api/weights" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

# Count server processes
count_server_processes() {
    pgrep -f "python3 server.py" | wc -l
}

# Kill all server processes
kill_all_servers() {
    log "${YELLOW}Killing all server processes...${NC}"
    
    # Get all PIDs
    local pids=$(pgrep -f "python3 server.py")
    
    if [ -n "$pids" ]; then
        # Graceful shutdown
        for pid in $pids; do
            kill "$pid" 2>/dev/null
        done
        sleep 2
        
        # Force kill if still running
        for pid in $pids; do
            if kill -0 "$pid" 2>/dev/null; then
                log "${YELLOW}Force killing PID $pid${NC}"
                kill -9 "$pid" 2>/dev/null
            fi
        done
    fi
    
    rm -f "$PID_FILE"
}

# Start server
start_server() {
    log "${BLUE}Starting server...${NC}"
    
    # Check for existing processes
    local running=$(count_server_processes)
    if [ "$running" -gt 0 ]; then
        log "${YELLOW}Server processes already running ($running). Cleaning up...${NC}"
        kill_all_servers
        sleep 2
    fi
    
    # Start new server
    cd "$SCRIPT_DIR"
    nohup python3 server.py >> "$LOG_FILE" 2>> "$ERROR_LOG" &
    local new_pid=$!
    
    # Save PID immediately
    echo "$new_pid" > "$PID_FILE"
    
    # Wait for server to start
    local attempts=0
    local max_attempts=15
    
    while [ $attempts -lt $max_attempts ]; do
        sleep 1
        attempts=$((attempts + 1))
        
        # Check if process is still running
        if ! kill -0 "$new_pid" 2>/dev/null; then
            error_log "Server process died during startup"
            rm -f "$PID_FILE"
            return 1
        fi
        
        # Check if API is responding
        if curl -s --connect-timeout 1 "http://localhost:8081/api/weights" > /dev/null 2>&1; then
            log "${GREEN}Server started successfully (PID: $new_pid)${NC}"
            return 0
        fi
    done
    
    # Even if API check fails, if process is running, consider it started
    if kill -0 "$new_pid" 2>/dev/null; then
        log "${YELLOW}Server process running but API slow to respond (PID: $new_pid)${NC}"
        return 0
    fi
    
    error_log "Server failed to start within ${max_attempts} seconds"
    rm -f "$PID_FILE"
    return 1
}

# Stop server
stop_server() {
    log "${BLUE}Stopping server...${NC}"
    kill_all_servers
    log "${GREEN}Server stopped${NC}"
}

# Restart server
restart_server() {
    log "${BLUE}Restarting server...${NC}"
    stop_server
    sleep 2
    start_server
}

# Status check
status() {
    echo "=== Server Status ==="
    echo ""
    
    # Process check
    if is_server_running; then
        local pid=$(cat "$PID_FILE")
        echo -e "${GREEN}Process: Running (PID: $pid)${NC}"
    else
        echo -e "${RED}Process: Not running${NC}"
        if [ -f "$PID_FILE" ]; then
            echo -e "${YELLOW}  (stale PID file)${NC}"
        fi
    fi
    
    # Response check
    if is_server_responding; then
        echo -e "${GREEN}API: Responding${NC}"
    else
        echo -e "${RED}API: Not responding${NC}"
    fi
    
    # Port check
    if netstat -tlnp 2>/dev/null | grep -q ":8081 " || ss -tlnp 2>/dev/null | grep -q ":8081 "; then
        echo -e "${GREEN}Port 8081: Listening${NC}"
    else
        echo -e "${RED}Port 8081: Not listening${NC}"
    fi
    
    # Process count
    local count=$(count_server_processes)
    echo -e "Processes: $count"
    
    # Lock status
    if [ -f "$LOCK_FILE" ]; then
        echo -e "${YELLOW}Lock file present (PID: $(cat $LOCK_FILE))${NC}"
    else
        echo "Lock: None"
    fi
    
    # Watchdog status
    if [ -f "$WATCHDOG_PID" ]; then
        local wpid=$(cat "$WATCHDOG_PID")
        if kill -0 "$wpid" 2>/dev/null; then
            echo -e "${GREEN}Watchdog: Running (PID: $wpid)${NC}"
        else
            echo -e "${YELLOW}Watchdog: Stale PID file${NC}"
        fi
    else
        echo "Watchdog: Not running"
    fi
}

# Watchdog mode - auto-restart on crash
watchdog() {
    log "${BLUE}Starting watchdog mode...${NC}"
    
    if ! acquire_lock; then
        exit 1
    fi
    
    # Save watchdog PID
    echo $$ > "$WATCHDOG_PID"
    
    # Cleanup on exit
    trap 'log "Watchdog stopping..."; release_lock; rm -f "$WATCHDOG_PID"; exit 0' SIGTERM SIGINT SIGHUP
    
    local restart_count=0
    local last_restart=0
    
    # Check server status and only start if not running
    local running_pids=$(pgrep -f "python3 server.py" 2>/dev/null)
    if [ -n "$running_pids" ]; then
        local pid_count=$(echo "$running_pids" | wc -l)
        log "${YELLOW}Found $pid_count existing server process(es)${NC}"
        
        # If multiple processes, clean up extras
        if [ "$pid_count" -gt 1 ]; then
            log "${YELLOW}Multiple server processes detected, cleaning up...${NC}"
            # Keep only the first one
            local first_pid=$(echo "$running_pids" | head -1)
            for pid in $running_pids; do
                if [ "$pid" != "$first_pid" ]; then
                    log "Killing extra process $pid"
                    kill -9 "$pid" 2>/dev/null
                fi
            done
            sleep 1
        fi
        
        # Use existing server's PID
        local first_pid=$(echo "$running_pids" | head -1)
        echo "$first_pid" > "$PID_FILE"
        log "${GREEN}Using existing server (PID: $first_pid)${NC}"
    else
        log "${YELLOW}No server running, starting new one...${NC}"
        start_server
        sleep 3
    fi
    
    while true; do
        local current_time=$(date +%s)
        
        # Check if server is running
        if ! is_server_running; then
            log "${RED}Server process not found${NC}"
            
            # Reset restart count if it's been a while since last restart
            if [ $((current_time - last_restart)) -gt 60 ]; then
                restart_count=0
            fi
            
            restart_count=$((restart_count + 1))
            last_restart=$current_time
            
            if [ $restart_count -gt $MAX_RESTART ]; then
                error_log "Max restart attempts ($MAX_RESTART) reached. Waiting 60 seconds..."
                sleep 60
                restart_count=0
                continue
            fi
            
            log "${YELLOW}Restarting server (attempt $restart_count)${NC}"
            start_server
            sleep $RESTART_DELAY
            continue
        fi
        
        # Check if server is responding (less strict - only check every 3 cycles)
        if [ $((current_time % 30)) -eq 0 ]; then
            if ! is_server_responding; then
                log "${YELLOW}Server not responding, checking...${NC}"
                sleep 3
                
                if ! is_server_responding; then
                    log "${YELLOW}Still not responding, restarting...${NC}"
                    
                    restart_count=$((restart_count + 1))
                    last_restart=$current_time
                    
                    if [ $restart_count -gt $MAX_RESTART ]; then
                        error_log "Max restart attempts ($MAX_RESTART) reached. Waiting 60 seconds..."
                        sleep 60
                        restart_count=0
                        continue
                    fi
                    
                    restart_server
                    sleep $RESTART_DELAY
                    continue
                fi
            fi
        fi
        
        # Reset restart count on successful health check after 30 seconds
        if [ $restart_count -gt 0 ] && [ $((current_time - last_restart)) -gt 30 ]; then
            restart_count=0
        fi
        
        sleep $HEALTH_CHECK_INTERVAL
    done
}

# Stop watchdog
stop_watchdog() {
    if [ -f "$WATCHDOG_PID" ]; then
        local wpid=$(cat "$WATCHDOG_PID")
        if kill -0 "$wpid" 2>/dev/null; then
            log "Stopping watchdog (PID: $wpid)"
            kill "$wpid" 2>/dev/null
            sleep 1
        fi
        rm -f "$WATCHDOG_PID"
    fi
    
    # Also release lock
    release_lock
}

case "$1" in
    start)
        if ! acquire_lock; then
            exit 1
        fi
        start_server
        release_lock
        ;;
    stop)
        stop_watchdog
        stop_server
        ;;
    restart)
        stop_watchdog
        stop_server
        sleep 2
        start_server
        ;;
    watchdog)
        watchdog
        ;;
    status)
        status
        ;;
    logs)
        tail -100 "$LOG_FILE"
        ;;
    errors)
        tail -50 "$ERROR_LOG"
        ;;
    clean)
        stop_watchdog
        kill_all_servers
        rm -f "$PID_FILE" "$LOCK_FILE" "$WATCHDOG_PID"
        log "Cleaned up all server processes and lock files"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|watchdog|status|logs|errors|clean}"
        echo ""
        echo "Commands:"
        echo "  start    - Start the server"
        echo "  stop     - Stop server and watchdog"
        echo "  restart  - Restart the server"
        echo "  watchdog - Start auto-restart watchdog"
        echo "  status   - Check server status"
        echo "  logs     - View recent server logs"
        echo "  errors   - View recent error logs"
        echo "  clean    - Kill all processes and remove lock files"
        exit 1
        ;;
esac