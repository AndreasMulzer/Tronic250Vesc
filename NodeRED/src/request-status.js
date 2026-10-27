function frame(p) {
    let crc = 0;
    for (const b of p) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 65535 : (crc << 1) & 65535;
    }
    return Buffer.from([2, p.length, ...p, crc >> 8, crc & 255, 3]);
}
return [[
    {topic: "request", payload: frame([34, 29, 4])},
    {topic: "control_request", payload: frame([34, 29, 36, 3])}
]];
