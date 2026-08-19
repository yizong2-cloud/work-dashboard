// Edge Function 投递失败的纯规则分类：永久性数据问题不应进入自动重试。
import { classifyDeliveryFailure as classify } from './delivery-classification.mjs'

export type DeliveryDisposition = 'retry' | 'skip'
export const classifyDeliveryFailure = (message: string): DeliveryDisposition => classify(message) as DeliveryDisposition
