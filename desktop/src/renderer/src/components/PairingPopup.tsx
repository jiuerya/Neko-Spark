import { useEffect, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { AppStatus } from '@shared/types'

interface PairingPopupProps {
  status: AppStatus
  pending: boolean
  onClose: () => void
}

/** 手机搜索主机时显示待配对状态，成功后切换为完成状态。 */
export default function PairingPopup({ status, pending, onClose }: PairingPopupProps): JSX.Element {
  const [qr, setQr] = useState('')
  const address = status.hub.addresses[0] ?? ''
  const code = status.hub.pairingCode ?? ''
  const link = address && code
    ? (() => {
        const value = new URL('neko-spark://pair')
        value.searchParams.set('url', address)
        value.searchParams.set('fingerprint', status.hubCertFingerprint)
        value.searchParams.set('code', code)
        return value.toString()
      })()
    : ''

  useEffect(() => {
    let alive = true
    setQr('')
    if (!link) return () => { alive = false }
    void QRCode.toDataURL(link, { width: 340, margin: 3, errorCorrectionLevel: 'L' })
      .then((dataUrl) => {
        if (alive) setQr(dataUrl)
      })
      .catch(() => {
        if (alive) setQr('')
      })
    return () => {
      alive = false
    }
  }, [link])

  return (
    <div className="pairing-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="pairing-popup" role="dialog" aria-modal="true" aria-labelledby="pairing-popup-title">
        <div className="pairing-popup-head">
          <div>
            <h2 id="pairing-popup-title">{pending ? '等待手机输入配对码' : '手机已完成配对'}</h2>
            <p>{pending ? '手机正在查找这台电脑，请把下面的一次性配对码输入到手机。' : '手机已拿到访问权限，设备信息已刷新。下面的信息只显示在这台电脑上。'}</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>

        <div className="pairing-popup-body">
          {qr ? <img className="pairing-popup-qr" src={qr} alt="手机扫描配对二维码" /> : <div className="pairing-popup-qr-empty">二维码生成中...</div>}
          <strong className="pairing-popup-code">{code || '配对码已刷新'}</strong>
          {pending ? (
            <div className="pairing-popup-field">
              <span>当前状态</span>
              <code>等待手机提交配对码</code>
            </div>
          ) : (
            <div className="pairing-popup-field">
              <span>互联网访问密钥</span>
              <code>{status.hubToken || '初始化中...'}</code>
            </div>
          )}
          {status.hub.pairingExpiresAt ? (
            <span className="hint">新的配对码有效至 {new Date(status.hub.pairingExpiresAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
      </section>
    </div>
  )
}
