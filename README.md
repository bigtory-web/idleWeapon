# 일꾼 키우기

가방 안에서 캐릭터와 무기를 상하좌우로 연결해 병사를 소환하는 모바일 우선 자동전투 웹 프로토타입입니다.

## 실행

```bash
npm install
npm run dev
```

## 검증

```bash
npm run test:game
npm run build
node --test tests/rendered-html.test.mjs
```

기본 검증 시드는 `prototype-001`이며 URL의 `?seed=` 값으로 같은 보상 순서를 재현할 수 있습니다. 진행 중 런은 저장하지 않고 설정과 최근 전투 결과만 브라우저에 저장합니다.
