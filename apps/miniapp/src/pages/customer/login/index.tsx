import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { authApi, saveSession } from '../../../services/api'
import './index.scss'

/**
 * 客户登录（P0-T50）：账密演示通道（seed 演示账号 cust-c0001 / demo1234），
 * 正式微信授权登录后续版本接入。仅 CUSTOMER 角色可进客户端，登录成功切到「订货」tab。
 */
export default function CustomerLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (submitting) return
    if (!username.trim() || !password) {
      Taro.showToast({ title: '请输入客户账号和密码', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const res = await authApi.login(username.trim(), password)
      if (res.user?.role !== 'CUSTOMER') {
        Taro.showToast({ title: '该账号不是客户账号，请联系商家开通', icon: 'none' })
        return
      }
      saveSession(res)
      Taro.showToast({ title: `欢迎，${res.user.name}`, icon: 'none' })
      Taro.switchTab({ url: '/pages/customer/products/index' })
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '登录失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='login'>
      <View className='login__hd'>
        <Text className='login__title'>客户登录</Text>
        <Text className='login__sub'>用商家给您的账号登录后即可订酒</Text>
      </View>

      <View className='login__form'>
        <Input
          className='ipt'
          placeholder='客户账号'
          value={username}
          onInput={(e) => setUsername(e.detail.value)}
        />
        <Input
          className='ipt'
          password
          placeholder='密码'
          value={password}
          onInput={(e) => setPassword(e.detail.value)}
        />
        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting}
          onClick={() => { void submit() }}
        >
          登 录
        </Button>
        <Text className='login__tip'>演示账号：cust-c0001　密码：demo1234</Text>
      </View>
    </View>
  )
}
