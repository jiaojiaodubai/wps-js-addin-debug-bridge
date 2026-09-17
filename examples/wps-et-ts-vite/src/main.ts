/**
 * 加载项页面入口。
 *
 * WPS 是按名字（onLoad="OnAddinLoad"、onAction="OnAction"）去全局找回调的，
 * 而 ES 模块里的函数不是全局的，所以要显式挂一次 ——
 * 纯 JS 示例用普通 <script> 加载，就没有这一步。
 */
import { OnAction, OnAddinLoad, OnGetEnabled } from "./ribbon"

Object.assign(window, { OnAction, OnAddinLoad, OnGetEnabled })
