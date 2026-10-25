/**
 * 演示动销出库分配。销量超过现存时先补一笔入库，再把每天的 OUT 分到还有余量的批次上，
 * 保证每个批次和商品净库存都不为负。补入库量等于销量时，出库后在库仍等于出库前的正库存
 * （青岛啤酒注释里的「在库 4080」就是这个数，而不是 4080−4440）。
 *
 * @param {Array<{ id: string, net: number }>} currentNets 按入库先后
 * @param {number[]} dailyQty 每一天的出库量（最小单位）
 * @returns {{ topUp: number, topUpBatchId: string | null, perDay: Array<Array<{ batchId: string, qty: number }>> }}
 */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function planDemoOutbound(currentNets, dailyQty) {
  if (!Array.isArray(currentNets) || currentNets.length === 0) {
    throw new Error('演示出库缺少批次');
  }
  if (!Array.isArray(dailyQty) || dailyQty.length === 0 || dailyQty.some((q) => !(q > 0))) {
    throw new Error('演示出库每天数量须大于 0');
  }
  const nets = currentNets.map((n) => ({ id: String(n.id), net: Number(n.net) }));
  const salesQty = dailyQty.reduce((sum, q) => sum + Number(q), 0);
  const positive = nets.reduce((sum, n) => sum + Math.max(0, n.net), 0);
  const topUp = salesQty > positive + 1e-9 ? round3(salesQty) : 0;
  const topUpBatchId = topUp > 0 ? nets[0].id : null;
  const rooms = nets.map((n) => ({ id: n.id, room: Math.max(0, n.net) }));
  if (topUp > 0) rooms[0].room += topUp;

  const perDay = dailyQty.map((qty) => {
    let left = Number(qty);
    const rows = [];
    for (const room of rooms) {
      if (left <= 1e-9) break;
      const take = Math.min(room.room, left);
      if (take > 1e-9) {
        rows.push({ batchId: room.id, qty: round3(take) });
        room.room -= take;
        left -= take;
      }
    }
    if (left > 1e-6) throw new Error(`演示出库 ${salesQty} 无法在非负库存下分配`);
    return rows;
  });
  return { topUp, topUpBatchId, perDay };
}

module.exports = { planDemoOutbound };
