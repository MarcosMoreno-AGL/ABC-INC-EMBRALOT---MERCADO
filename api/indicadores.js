// Vercel Serverless Function — pulls official live data for the market ticker.
// Sources: Banco Central do Brasil SGS API (public, no key) + Yahoo Finance chart API (Ibovespa).
// CUB-SC and the FipeZap city ranking have no public API — those stay out of this
// endpoint and are refreshed by the monthly reviewed routine instead.

const SGS_BASE = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';

async function sgs(code, n) {
  const url = `${SGS_BASE}.${code}/dados/ultimos/${n}?formato=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'abc-inc-ticker/1.0' } });
  if (!r.ok) throw new Error(`SGS ${code} HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`SGS ${code} empty response`);
  return data;
}

function acc12(monthlySeries) {
  const last12 = monthlySeries.slice(-12);
  if (last12.length < 12) throw new Error('insufficient months for 12m accumulation');
  const factor = last12.reduce((acc, x) => acc * (1 + parseFloat(x.valor) / 100), 1);
  return (factor - 1) * 100;
}

function brDateToLabel(brDate) {
  // "01/08/2026" -> "ago/26"
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [, mm, yyyy] = brDate.split('/');
  return `${meses[parseInt(mm, 10) - 1]}/${yyyy.slice(2)}`;
}

function brDateToDayLabel(brDate) {
  // "01/09/2026" -> "01/set/26"
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [dd, mm, yyyy] = brDate.split('/');
  return `${dd}/${meses[parseInt(mm, 10) - 1]}/${yyyy.slice(2)}`;
}

// Day-over-day trend for a quote: direction drives the green/red highlight in the ticker.
function trend(current, previous) {
  if (!isFinite(current) || !isFinite(previous) || previous === 0) {
    return { direction: 'flat', changePct: null, changeLabel: '' };
  }
  const pct = (current / previous - 1) * 100;
  const direction = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•';
  const changeLabel = direction === 'flat'
    ? '0,00%'
    : `${arrow} ${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(2).replace('.', ',')}%`;
  return { direction, changePct: pct, changeLabel };
}

export default async function handler(req, res) {
  try {
    const [usd, ipca12, igpmHist, inccHist, cdi, ibovResp] = await Promise.all([
      sgs(1, 5),       // USD/BRL PTAX venda (diário) — 5 p/ pegar o fechamento anterior mesmo após feriado
      sgs(13522, 1),   // IPCA acumulado 12 meses (IBGE, via BCB)
      sgs(189, 13),    // IGP-M variação mensal (FGV) — 13 meses p/ compor 12m com folga
      sgs(192, 13),    // INCC-M variação mensal (FGV)
      sgs(4389, 1),    // CDI anualizada base 252
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?interval=1d&range=5d', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }).then(r => { if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`); return r.json(); })
    ]);

    const igpm12 = acc12(igpmHist);
    const incc12 = acc12(inccHist);
    const ibovResult = ibovResp?.chart?.result?.[0];
    const ibovMeta = ibovResult?.meta;
    if (!ibovMeta?.regularMarketPrice) throw new Error('Ibovespa price missing');

    const ibovDate = new Date(ibovMeta.regularMarketTime * 1000);
    const ibovDateBR = `${String(ibovDate.getDate()).padStart(2,'0')}/${String(ibovDate.getMonth()+1).padStart(2,'0')}/${ibovDate.getFullYear()}`;

    // USD day-over-day: last two available PTAX closes.
    const usdNow = parseFloat(usd[usd.length - 1].valor);
    const usdPrev = usd.length > 1 ? parseFloat(usd[usd.length - 2].valor) : NaN;
    const usdTrend = trend(usdNow, usdPrev);

    // Ibovespa day-over-day: last two distinct daily closes, falling back to Yahoo's chartPreviousClose.
    const ibovCloses = (ibovResult?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
    const ibovNow = ibovCloses.length ? ibovCloses[ibovCloses.length - 1] : ibovMeta.regularMarketPrice;
    const ibovPrev = ibovCloses.length > 1 ? ibovCloses[ibovCloses.length - 2] : ibovMeta.chartPreviousClose;
    const ibovTrend = trend(ibovNow, ibovPrev);

    const payload = {
      updatedAt: new Date().toISOString(),
      usdbrl: { value: usdNow, label: `R$ ${usdNow.toFixed(2).replace('.', ',')}`, date: brDateToDayLabel(usd[usd.length - 1].data), direction: usdTrend.direction, changePct: usdTrend.changePct, changeLabel: usdTrend.changeLabel },
      ibovespa: { value: Math.round(ibovMeta.regularMarketPrice), label: `${Math.round(ibovMeta.regularMarketPrice).toLocaleString('pt-BR')} pts`, date: brDateToDayLabel(ibovDateBR), direction: ibovTrend.direction, changePct: ibovTrend.changePct, changeLabel: ibovTrend.changeLabel },
      ipca12m: { value: parseFloat(ipca12[0].valor), label: `${parseFloat(ipca12[0].valor).toFixed(2).replace('.', ',')}%`, date: brDateToLabel(ipca12[0].data) },
      inccm12m: { value: incc12, label: `${incc12.toFixed(2).replace('.', ',')}%`, date: brDateToLabel(inccHist[inccHist.length - 1].data) },
      cdi: { value: parseFloat(cdi[0].valor), label: `${parseFloat(cdi[0].valor).toFixed(2).replace('.', ',')}%`, date: brDateToLabel(cdi[0].data) },
      igpm12m: { value: igpm12, label: `${igpm12.toFixed(2).replace('.', ',')}%`, date: brDateToLabel(igpmHist[igpmHist.length - 1].data) }
    };

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: 'fetch_failed', message: err.message });
  }
}
