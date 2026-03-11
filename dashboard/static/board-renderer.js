// ─── Shared Board Renderer ─────────────────────────────────────────────────────
// Common board drawing functions used by both game.js and dashboard/static/script.js

const BoardRenderer = {
    BOARD_SIZE: 15,
    STAR_POINTS: [[3,3],[3,7],[3,11],[7,3],[7,7],[7,11],[11,3],[11,7],[11,11]],

    drawBoard(ctx, cellSize, boardSize) {
        const canvasSize = boardSize * cellSize;
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, canvasSize, canvasSize);

        ctx.strokeStyle = '#404040';
        ctx.lineWidth = 1;
        const offset = cellSize / 2;

        for (let i = 0; i < boardSize; i++) {
            ctx.beginPath();
            ctx.moveTo(offset, offset + i * cellSize);
            ctx.lineTo(canvasSize - offset, offset + i * cellSize);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(offset + i * cellSize, offset);
            ctx.lineTo(offset + i * cellSize, canvasSize - offset);
            ctx.stroke();
        }

        ctx.fillStyle = '#505050';
        this.STAR_POINTS.forEach(([x, y]) => {
            if (x < boardSize && y < boardSize) {
                ctx.beginPath();
                ctx.arc(offset + x * cellSize, offset + y * cellSize, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    },

    drawStone(ctx, row, col, player, cellSize, isLast) {
        const x = cellSize / 2 + col * cellSize;
        const y = cellSize / 2 + row * cellSize;
        const radius = cellSize / 2 - 2;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);

        if (player === 1) {
            const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
            gradient.addColorStop(0, '#1a1a1a');
            gradient.addColorStop(1, '#000000');
            ctx.fillStyle = gradient;
            ctx.strokeStyle = '#808080';
        } else {
            const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(1, '#c0c0c0');
            ctx.fillStyle = gradient;
            ctx.strokeStyle = '#909090';
        }

        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (isLast) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = player === 1 ? '#ffffff' : '#000000';
            ctx.lineWidth = 3;
            ctx.stroke();
        }
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BoardRenderer;
}
