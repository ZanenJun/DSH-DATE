import {DateTime} from 'luxon';

export function formatBalance(status,timeZone='Asia/Shanghai') {
  if(status.enabled===false)return '余额监测尚未开启。';
  const lines=[];
  if(status.lastError)lines.push('余额暂不可查询；以下缓存不代表当前余额。');
  if(status.balance) {
    for(const row of status.balance.balance_infos) {
      const unit=row.currency==='CNY'?'元':row.currency==='USD'?'美元':row.currency;
      lines.push(`${row.currency} 可用余额：${row.total_balance} ${unit}（赠金 ${row.granted_balance}，充值余额 ${row.topped_up_balance}）。`);
    }
    if(!status.balance.balance_infos.length)lines.push('接口未返回余额明细。');
    if(status.lastSuccessAt)lines.push(`查询时间：${DateTime.fromISO(status.lastSuccessAt).setZone(timeZone).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}。`);
    if(!status.lastError)lines.push(status.confirmedInsufficient || status.balance.is_available===false
      ?'已确认额度不足，模型调用可能中断；充值后会继续检查恢复。'
      :'接口显示账户可继续调用；这是账户余额，不是本插件单独的费用。');
  } else if(!status.lastError)lines.push('尚未成功查询余额，请稍后重试。');
  if(status.confirmedInsufficient && status.lastError)lines.push('此前模型已返回余额不足；尚未确认恢复。');
  return lines.join('\n');
}
