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

export default async function handler(req, res) {
  try {
    const [usd, ipca12, igpmHist, inccHist, cdi, ibovResp] = await Promise.all([
      sgs(1, 1),       // USD/BRL PTAX venda (diário)
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
    const ibovMeta = ibovResp?.chart?.result?.[0]?.meta;
    if (!ibovMeta?.regularMarketPrice) throw new Error('Ibovespa price missing');

    const ibovDate = new Date(ibovMeta.regularMarketTime * 1000);
    const ibovDateBR = `${String(ibovDate.getDate()).padStart(2,'0')}/${String(ibovDate.getMonth()+1).padStart(2,'0')}/${ibovDate.getFullYear()}`;

    const payload = {
      updatedAt: new Date().toISOString(),
      usdbrl: { value: parseFloat(usd[0].valor), label: `R$ ${parseFloat(usd[0].valor).toFixed(2).replace('.', ',')}`, date: brDateToDayLabel(usd[0].data) },
      ibovespa: { value: Math.round(ibovMeta.regularMarketPrice), label: `${Math.round(ibovMeta.regularMarketPrice).toLocaleString('pt-BR')} pts`, date: brDateToDayLabel(ibovDateBR) },
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
