"use strict";
function chunk(name,bytes){const head=Buffer.alloc(8);head.write(name);head.writeUInt32LE(bytes.length,4);return Buffer.concat([head,bytes,...(bytes.length%2?[Buffer.alloc(1)]:[])]);}
function wave({sampleRate=16000,frames=1600,format=16,extraChunks=false}={}){
  const pcm=Buffer.alloc(frames*2);for(let i=0;i<frames;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/sampleRate)*12000),i*2);
  const fmt=Buffer.alloc(format);fmt.writeUInt16LE(format===40?0xfffe:1,0);fmt.writeUInt16LE(1,2);fmt.writeUInt32LE(sampleRate,4);fmt.writeUInt32LE(sampleRate*2,8);fmt.writeUInt16LE(2,12);fmt.writeUInt16LE(16,14);
  if(format===40){fmt.writeUInt16LE(22,16);fmt.writeUInt16LE(16,18);fmt.writeUInt32LE(4,20);Buffer.from("0100000000001000800000aa00389b71","hex").copy(fmt,24);}
  const body=Buffer.concat([Buffer.from("WAVE"),...(extraChunks?[chunk("JUNK",Buffer.from("odd"))]:[]),chunk("fmt ",fmt),...(extraChunks?[chunk("LIST",Buffer.from("INFO"))]:[]),chunk("data",pcm)]),header=Buffer.alloc(8);header.write("RIFF");header.writeUInt32LE(body.length,4);
  return {bytes:Buffer.concat([header,body]),pcm};
}
module.exports={wave,chunk};
