// Operator-only one-shot trigger. Credentials arrive through hidden stdin, never argv/files.
// This is not a scheduler and does not retry ambiguous requests.
const endpoint='https://slackdot-compatibility.paryllax.chatgpt.site/internal/deliver';

function readCredential() {
  return new Promise((resolve,reject)=>{
    let input='';
    const terminal=Boolean(process.stdin.isTTY);
    const finish=(error)=>{
      process.stdin.off('data',onData);process.stdin.off('end',onEnd);
      if(terminal) process.stdin.setRawMode(false);
      process.stdin.pause();
      if(error) reject(error); else {
        try { const parsed=JSON.parse(input);input='';resolve(parsed.secret); }
        catch {reject(new Error('Invalid credential input'));}
      }
    };
    const onData=(chunk)=>{
      const text=chunk.toString();
      if(text.includes('\u0003')) return finish(new Error('Cancelled'));
      input+=text;
      if(input.length>2048) return finish(new Error('Credential input too large'));
      if(/[\r\n]/.test(input)) finish();
    };
    const onEnd=()=>finish();
    if(terminal)process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',onData);process.stdin.once('end',onEnd);process.stdin.resume();
    process.stdout.write('Ready for one-shot delivery credential JSON on stdin (input is hidden).\n');
  });
}

let stage='credential_input';
try {
  const secret=await readCredential();
  stage='credential_validation';
  if(typeof secret!=='string'||secret.length<32||secret.length>256||/[\r\n]/.test(secret)) throw new Error('Invalid credential input');
  if(process.argv.includes('--check-input')) {
    console.log(JSON.stringify({credentialInputValid:true,requestSent:false}));
    process.exit(0);
  }
  const started=new Date().toISOString();
  stage='request';
  const response=await fetch(endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),
    headers:{Authorization:`Bearer ${secret}`}});
  stage='response';
  const body=await response.json().catch(()=>null);
  // Print only bounded operation metadata, never headers or arbitrary server response data.
  console.log(JSON.stringify({started,finished:new Date().toISOString(),status:response.status,
    processed:Number.isSafeInteger(body?.processed)&&body.processed>=0&&body.processed<=10?body.processed:undefined}));
  if(!response.ok)process.exitCode=1;
} catch {
  console.error(JSON.stringify({stage,requestMayHaveBeenSent:stage==='request'||stage==='response'}));
  console.error('One-shot delivery did not return a confirmed successful response. Do not retry automatically; reconcile hosted logs first.');
  process.exitCode=1;
}
