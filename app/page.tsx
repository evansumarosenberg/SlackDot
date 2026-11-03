export default function Home() {
  return <main style={{maxWidth:680,margin:'15vh auto',padding:32,fontFamily:'system-ui'}}>
    <p style={{color:'#64748b'}}>SLACK BRIDGE</p>
    <h1 style={{fontSize:52,letterSpacing:'-0.04em'}}>SlackDot</h1>
    <p style={{fontSize:20,lineHeight:1.6}}>A Slack connection for your dot.</p>
    <p>SlackDot connects one Slack bot to one controlling dot. Protected operations require the configured owner.</p>
    <p>Connect the Site plugin in ChatGPT and give your dot explicit monitoring and reply instructions.</p>
    <p><a href="/setup">Owner setup</a> · <a href="/health">Service health</a></p>
  </main>;
}
