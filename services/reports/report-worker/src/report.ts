/** Deterministic fake usage data, so the same period always gives the same CSV. */
export function buildUsageCsv(period: string): { csv: string; rows: number } {
  const [year, month] = period.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();

  let seed = year * 100 + month;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };

  const lines = ['date,active_users,api_calls'];
  for (let day = 1; day <= days; day++) {
    const date = `${period}-${String(day).padStart(2, '0')}`;
    lines.push(`${date},${200 + (next() % 150)},${8000 + (next() % 6000)}`);
  }
  return { csv: `${lines.join('\n')}\n`, rows: days };
}
