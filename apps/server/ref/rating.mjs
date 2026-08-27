import { rate, rating, ordinal } from 'openskill';

const casos = [
  [ [ {mu:25,sigma:25/3}, {mu:25,sigma:25/3} ] ],
  [ [ {mu:25,sigma:25/3}, {mu:25,sigma:25/3}, {mu:25,sigma:25/3} ] ],
  [ [ {mu:30,sigma:5}, {mu:25,sigma:25/3}, {mu:18.4,sigma:6.2}, {mu:25,sigma:25/3} ] ],
  [ [ {mu:12.3,sigma:2.1}, {mu:41.7,sigma:7.9}, {mu:25,sigma:25/3}, {mu:33.3,sigma:1.05}, {mu:8,sigma:8.33} ] ],
  [ [ {mu:25,sigma:25/3}, {mu:25,sigma:25/3}, {mu:25,sigma:25/3}, {mu:25,sigma:25/3},
      {mu:25,sigma:25/3}, {mu:25,sigma:25/3}, {mu:25,sigma:25/3}, {mu:25,sigma:25/3},
      {mu:25,sigma:25/3}, {mu:25,sigma:25/3} ] ],
];

const saida = [];
for (const [jogadores] of casos) {
  const teams = jogadores.map((r) => [r]);
  const rank = jogadores.map((_, i) => i);
  const res = rate(teams, { rank });
  saida.push({
    entrada: jogadores,
    saida: res.map((t) => t[0]),
    ordinais: res.map((t) => ordinal(t[0])),
  });
}
console.log(JSON.stringify({ padrao: rating(), casos: saida }, null, 0));
