// Continuous primal simplex for max c·x subject to Ax <= b, x >= 0.
// Every input row has a nonnegative bound, so the slack basis is feasible.
const EPS=1e-10;
export function solveContinuousFunding({coefficients,limits,objectives}){
 const m=limits.length,n=objectives.length;if(!m||!n)return {amounts:Array(n).fill(0),objective:0};
 for(const v of [...limits,...objectives,...coefficients.flat()])if(!Number.isFinite(v))throw new TypeError('finite LP coefficients required');
 if(limits.some(v=>v<0)||coefficients.length!==m||coefficients.some(row=>row.length!==n||row.some(v=>v<0)))throw new TypeError('invalid continuous funding LP');
 const T=Array.from({length:m+1},()=>new Float64Array(n+m+1)),basis=Array.from({length:m},(_,i)=>n+i),width=n+m;
 for(let i=0;i<m;i++){for(let j=0;j<n;j++)T[i][j]=coefficients[i][j];T[i][n+i]=1;T[i][width]=limits[i]}
 for(let j=0;j<n;j++)T[m][j]=-objectives[j];
 for(let iter=0;iter<10000;iter++){
  let enter=-1;for(let j=0;j<width;j++)if(T[m][j]<-EPS){enter=j;break}if(enter<0){const amounts=Array(n).fill(0);for(let i=0;i<m;i++)if(basis[i]<n)amounts[basis[i]]=Math.max(0,T[i][width]);return {amounts,objective:objectives.reduce((s,v,j)=>s+v*amounts[j],0)}}
  let leaving=-1,ratio=Infinity;for(let i=0;i<m;i++){const a=T[i][enter];if(a<=EPS)continue;const r=T[i][width]/a;if(r<ratio-EPS||Math.abs(r-ratio)<=EPS&&(leaving<0||basis[i]<basis[leaving])){ratio=r;leaving=i}}
  if(leaving<0)throw new Error('unbounded qualifying LP');const pivot=T[leaving][enter];for(let k=0;k<=width;k++)T[leaving][k]/=pivot;
  for(let i=0;i<=m;i++)if(i!==leaving){const factor=T[i][enter];if(factor)for(let k=0;k<=width;k++)T[i][k]-=factor*T[leaving][k]}
  basis[leaving]=enter;
 }
 throw new Error('qualifying LP failed to converge');
}
