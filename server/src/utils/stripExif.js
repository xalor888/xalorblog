/**
 * JPEG EXIF 剥离（上传隐私保护）
 * 相机/手机照片常携带 EXIF 元数据（GPS 坐标、设备型号、拍摄时间），
 * 直接上传到博客会泄露拍摄位置与设备信息。本工具按 JPEG 段结构重建文件，
 * 跳过 APP1(FFE1) EXIF 段，保留 APP2(FFE2) ICC 色彩管理段与压缩图像数据。
 * 纯 Node Buffer 实现，无第三方依赖。
 *
 * JPEG 结构：SOI(FFD8) → 段序列（FFxx + 2 字节长度(含自身) + 数据）→ SOS(FFDA) 后为熵编码数据
 * 独立标记（无长度字段）：FF01(TC) / FFD0-FFD9（RSTn/SOI/EOI）
 * FF00 为字节填充（仅合法出现在熵编码数据中，段间遇到视为填充跳过）
 */

/**
 * 剥离 EXIF：返回新 Buffer；解析异常时保守回退原文件（不损坏用户上传）
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function stripExif(buf) {
  // 快速失败：非 JPEG 或过小
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return buf; // 非法段结构 → 保守回退
    const marker = buf[i + 1];
    // 字节填充 FF00：跳过填充，从下一字节继续解析
    if (marker === 0x00) {
      i += 1;
      continue;
    }
    // 独立标记：无长度字段
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      if (marker === 0xd9) return Buffer.concat(out); // EOI：文件结束
      continue;
    }
    // 数据段：FFxx + 2 字节长度（含长度自身）+ 数据
    if (i + 3 >= buf.length) return buf;
    const segLen = (buf[i + 2] << 8) | buf[i + 3];
    if (segLen < 2) return buf; // 非法长度
    const end = i + 2 + segLen;
    if (end > buf.length) return buf; // 段越界 → 保守回退
    // 跳过 APP1(FFE1) EXIF 段；保留其余段（含 APP2 ICC 色彩管理）
    if (marker !== 0xe1) {
      out.push(buf.subarray(i, end));
    }
    i = end;
    if (marker === 0xda) {
      // SOS：其后全部为熵编码图像数据，原样拷贝并结束
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
  }
  // 未正常走到 EOI/SOS（尾部截断等）→ 保守回退
  return buf;
}

module.exports = { stripExif };
