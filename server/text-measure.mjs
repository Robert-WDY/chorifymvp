export const countBody=(body,unit)=>[...body.replace(/[*`#]/g,'').replace(unit==='characters'?/$^/u:/[\p{P}\p{Z}\s]/gu,'')].length;
